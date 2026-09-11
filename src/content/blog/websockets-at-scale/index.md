---
title: Scaling WebSockets in Node.js past one process
description: What breaks when a Node.js WebSocket service outgrows a single process, and the patterns that hold up for backpressure, fan-out, reconnects and compression.
date: 2026-08-01
tags:
  - nodejs
  - websockets
  - scaling
  - redis
---

Advice on scaling WebSockets usually starts with how many connections one Node process can hold, as if that number were the ceiling. It rarely is. A WebSocket server is a stateful service, and the things that fail at scale are all state: a send buffer that grows per client, a room membership list that exists in one process only, a reconnect handshake that every client runs at the same moment.

## Idle connections are cheap and busy ones are not

An idle WebSocket costs a file descriptor, kernel socket buffers, a handful of JavaScript objects, and a ping timer if you run heartbeats. It costs almost no CPU until messages flow. The expensive work happens per message: frame parsing, `JSON.stringify`, TLS, and compression if you enabled it. A process holding many quiet sockets and a process holding fewer chatty ones are different workloads, which is why per-process connection numbers from other people's posts don't transfer. Measure with your own message sizes and rates.

The limits that bite first are mostly operating system limits. Each connection needs a file descriptor, so the process `nofile` limit has to be raised well above the usual default, and in containers that limit comes from the runtime configuration and not from your shell. The next limit is easy to miss. A TCP connection is identified by source address, source port, destination address and destination port. Your clients each have their own source address, so they never collide with each other, but your load balancer does: every connection it opens to a given backend address and port needs a distinct source port, and the default ephemeral range on most Linux distributions is about 28,000 ports. One proxy talking to one backend can't hold more than that unless you give it more source addresses or more backends.

```bash title="limits.sh"
ulimit -n                                   # fd limit of this shell
grep 'open files' /proc/$(pgrep -f server.js | head -1)/limits
sysctl net.ipv4.ip_local_port_range         # ephemeral port range
ss -s                                       # socket counts by state
```

Memory is the third budget, and the only way to price it is empirically. Take a heap snapshot at a known connection count, take another at double that count, and the difference per connection covers `ws` internals plus everything your application hangs off each socket: user objects, subscription sets, caches. Heartbeats belong in this budget too. Many proxies close connections that sit idle for 60 seconds by default, so a ping every 20 to 30 seconds keeps the path open and lets you find dead peers.

## A slow client turns into your memory problem

This is the broadcast loop in most first versions:

```js title="broadcast-naive.js"
function broadcast(members, payload) {
  for (const ws of members) {
    ws.send(JSON.stringify(payload));
  }
}
```

It works until one client stops reading. That might be a phone on a bad link or a laptop that went to sleep with the TCP connection still open. The kernel send buffer for that socket fills, and from then on every `ws.send()` queues the frame in user space, inside your process. `send()` returns nothing to tell you this is happening, and the `maxPayload` option only bounds incoming messages. The queue grows at your publish rate until the connection is declared dead, which without application-level heartbeats can take a long time. During a network event that affects many clients at once, the same thing happens to all of them.

The check has to happen before you send, using `bufferedAmount`:

```js title="send-to-all.js"
const MAX_BUFFERED_BYTES = 1024 * 1024;
let slowConsumerTerminations = 0;

export function sendToAll(members, data) {
  for (const ws of members) {
    if (ws.readyState !== ws.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.terminate();
      slowConsumerTerminations++;
      continue;
    }
    ws.send(data);
  }
}
```

The code makes three choices. The caller serializes once per message instead of once per recipient. A client over the limit gets `terminate()` and not `close()`, because `close()` queues a close frame behind data the client already isn't reading, so the handshake can't finish. And the policy is yours to set: closing the client and letting it resync is right for chat, while for a price feed it is usually better to keep only the latest value per key and flush on a timer, so a slow client sees stale data and not a backlog.

The loop is synchronous, so a room with tens of thousands of members is one long tick of the event loop. Yielding in the middle is tempting, but then two broadcasts can interleave and some members see them in the opposite order. If you yield, serialize broadcasts per room.

## Rooms live in one process, so fan-out needs a broker

On one process a room is a `Set` of sockets and a broadcast is a loop over it. Put two processes behind a load balancer and the same code quietly delivers to part of the room, because each process only knows the sockets that connected to it. The usual fix is a message broker, and the detail that decides whether it scales is what you subscribe to: one subscription per room per process, not one per socket. Each process subscribes to a channel when its first local member joins a room, drops it when the last one leaves, and loops over its local members on every message. Direct messages work the same way, with a channel per user that the process subscribes to when that user connects to it.

```js title="rooms.js"
import { createClient } from 'redis';
import { sendToAll } from './send-to-all.js';

const pub = createClient({ url: process.env.REDIS_URL });
const sub = pub.duplicate();
await Promise.all([pub.connect(), sub.connect()]);

const rooms = new Map(); // room -> { members: Set<WebSocket>, ready: Promise }
const channel = (room) => `room:${room}`;

export async function join(ws, room) {
  let entry = rooms.get(room);
  if (!entry) {
    entry = { members: new Set() };
    rooms.set(room, entry);
    entry.ready = sub.subscribe(channel(room), (message) => {
      sendToAll(entry.members, message);
    });
  }
  entry.members.add(ws);
  await entry.ready;
}

export function leave(ws, room) {
  const entry = rooms.get(room);
  if (!entry) return;
  entry.members.delete(ws);
  if (entry.members.size === 0) {
    rooms.delete(room);
    return sub.unsubscribe(channel(room));
  }
}

export function publish(room, payload) {
  return pub.publish(channel(room), JSON.stringify(payload));
}
```

The sketch skips error handling, and a failed subscribe leaves a room that silently receives nothing. Test the leave-then-join path against your client library too, since clients differ in how they track listeners for a channel that is mid-unsubscribe.

What the broker guarantees matters more than which one you pick. Redis pub/sub is at-most-once: a subscriber that is disconnected when a message is published never sees it. In Redis Cluster, classic `PUBLISH` is also propagated to every node, so every node handles every message regardless of cluster size. Redis 7.0 added sharded pub/sub, `SSUBSCRIBE` and `SPUBLISH`, which pins each channel to the shard that owns its hash slot, so messages stay on that shard and capacity grows with shard count. The costs are no pattern subscriptions and a client that has to connect to the owning shard. A single hot channel still lives on one shard, so a room with extreme traffic has to be split by the application into several channels that every process subscribes to, which gives up ordering between them.

Redis also applies its own slow-consumer rule through `client-output-buffer-limit`, and a subscriber connection that falls behind its limit gets disconnected. That is the problem from the previous section, one hop earlier.

If you use Socket.IO, the adapter choice maps onto the same trade-offs. `@socket.io/redis-adapter` offers `createAdapter` for classic pub/sub and `createShardedAdapter` for the Redis 7 mode. Its README has carried a note that the sharded adapter doesn't work with `ioredis` against a cluster, and I haven't verified whether current `ioredis` releases changed that, so check the exact client and adapter versions you plan to run. The separate Redis Streams adapter forwards packets through a stream, resumes after a temporary Redis disconnect without losing packets, and supports Socket.IO's connection state recovery. Anything that has to survive a broker blip in general needs a log with offsets, such as Redis Streams, Kafka or NATS JetStream, and then the client resumes from the last offset it saw.

## Reconnect storms set the capacity you need

When a server process dies or restarts, every client it held tries to reconnect within seconds. Each one runs a TLS handshake, an HTTP upgrade, authentication, subscription setup and a state sync, which are the most expensive things your service does, and they all arrive together. Steady-state load says little about whether you survive that. The reconnect rate your backends can absorb is the number to size for.

Adding capacity during the incident helps less than people expect. Connections are long-lived, so new instances don't take over any of the connections already established. They stay nearly empty until new connections arrive, and the load balancer has to prefer them, which is what a least-connections policy is for. The same property is why autoscaling on CPU lags here: idle connections barely use CPU, so an instance can be full before the metric moves. Scale on connections per process and event loop delay instead.

The client half of the fix is backoff with full jitter: pick the delay uniformly between zero and an exponentially growing ceiling. Reset the attempt counter only after a connection has actually delivered data, because a server that accepts and then immediately drops would otherwise keep clients in a tight loop.

```js title="reconnect.js"
function reconnectDelay(attempt, baseMs = 1000, capMs = 30_000) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.random() * ceiling;
}

function connect(attempt = 0) {
  const ws = new WebSocket(url);
  let healthy = false;

  ws.onopen = () => ws.send(JSON.stringify({ type: 'resume', lastSeq }));
  ws.onmessage = (event) => {
    healthy = true;
    handle(event);
  };
  ws.onclose = () => {
    const next = healthy ? 0 : attempt + 1;
    setTimeout(() => connect(next), reconnectDelay(next));
  };
}
```

The base delay is a tuning knob. The window for the first retry has to be sized to the number of connections one instance holds and the accept rate of the instances that will receive them.

The server half is a gradual drain. On SIGTERM the instance stops accepting connections and closes its clients in batches with a 1001 close code, so the reconnects arrive as a ramp and not a spike.

```js title="drain.js"
import { setTimeout as sleep } from 'node:timers/promises';

const BATCH = 200;
const PAUSE_MS = 1000;

process.on('SIGTERM', async () => {
  server.close(); // stop accepting new connections
  const clients = [...wss.clients];
  for (let i = 0; i < clients.length; i += BATCH) {
    for (const ws of clients.slice(i, i + BATCH)) ws.close(1001, 'going away');
    await sleep(PAUSE_MS);
  }
  process.exit(0);
});
```

Two details around that code. The instance has to leave the load balancer's rotation before the drain starts, or it will accept connections it is about to close. And the orchestrator's termination grace period has to exceed the number of clients divided by the batch size, times the pause.

Resume has to be cheap too. Verify the auth token locally, with a signed token and not a database lookup. Stamp each room message with a sequence number from a single writer per room, and let the client send the last one it saw. The server replays from a short capped buffer if it still has the gap and tells the client to refetch a snapshot if it doesn't. This is also what keeps at-most-once pub/sub tolerable, since a lost message shows up as a gap in the sequence.

## Compression is off by default on the server for a reason

`ws` ships with permessage-deflate disabled on the server and enabled on the client, and its README says the extension adds significant performance and memory overhead and should be enabled only if it is really needed. The reason is zlib. Node's zlib binding has a long-standing problem on Linux where high concurrency can fragment memory badly. A benchmark quoted in `ws` issue 1202 queued the same deflate work at different concurrency levels: resident memory ended around 68 MB at a concurrency of 5 and around 3.1 GB with unbounded concurrency. It ran on whatever Node version was current when it was posted, so rerun it on yours before believing it or dismissing it.

If you need compression, tune it before turning it on:

```js title="compression.js"
const wss = new WebSocketServer({
  server,
  perMessageDeflate: {
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024,
  },
});
```

Disabling context takeover means no compression window stays in memory per connection, at the price of a worse ratio. The window bits cap how large a window can get when one is used. The last two values are the library defaults: a limit on concurrent zlib calls, and a minimum payload size below which nothing is compressed. For broadcast traffic there is another option. Compress the payload once in your own code, send the same compressed bytes as a binary frame to every recipient, and decompress on the client, for example with `DecompressionStream` in browsers. That is one deflate per message and no compression state per connection, in exchange for a client-side decompression step and a framing convention you have to maintain.

## The library you pick decides which of these problems you own

| | `ws` | uWebSockets.js | Socket.IO |
|---|---|---|---|
| What it is | WebSocket implementation in JavaScript, optional native `bufferutil` addon for masking | C++ core with JavaScript bindings, replaces `node:http` | Protocol on top of WebSocket with rooms, acknowledgements and reconnection |
| Rooms or topics | None, you write them | Built-in topics, in-process only | Built-in rooms |
| Backpressure | `bufferedAmount`, no drain event on the socket | `getBufferedAmount()`, `drain`, `maxBackpressure`, `closeOnBackpressureLimit` | `volatile` emits for droppable messages |
| Across processes | Bring your own broker | Bring your own broker | Redis adapters: pub/sub, sharded, streams |
| Watch for | Per-message deflate cost | Not a plugin for Express or Fastify | Sticky sessions with HTTP long-polling |

I'd start with `ws` and a room layer like the one above. It is small, it exposes `bufferedAmount`, and every decision in this post stays visible in your code. Move the hot path to uWebSockets.js if profiles show frame handling and fan-out loops dominating. Its topic pub/sub does the in-process fan-out in native code, `cork` packs many sends into one syscall, and `send()` returns a status number you can act on before the socket falls behind. In the current typings that is 1 for sent, 2 for dropped at the backpressure limit, and 0 for queued with backpressure building. It has its own HTTP server, and it has been distributed as prebuilt binaries installed from GitHub tags, which is worth checking against your Node upgrade and supply-chain process. Compression there is a setting per route, with a shared compressor or dedicated ones of several sizes, so the memory trade-off from the previous section shows up as a configuration choice. Its topics stay inside one process, so the broker sections still apply.

Socket.IO needs its own client on both ends, and in return you get rooms, acknowledgements and reconnection behavior you would otherwise write yourself. With HTTP long-polling enabled you need sticky sessions at the load balancer, and the Redis Streams adapter's FAQ says that still applies with that adapter. With only the WebSocket transport enabled that requirement should go away, but confirm it against the documentation for your version.

## What to watch, and the part that stays hard

Most of the failures above show up in a few numbers first:

- Open connections per process, plus connect and disconnect rates
- The maximum and p99 of `bufferedAmount` across sockets, and slow-consumer terminations per minute
- Event loop delay at p99
- File descriptors in use against the limit
- Resident set size and external memory per process
- Publish-to-deliver latency through the broker, and broker-side subscriber disconnects
- Reconnect rate and handshake duration
- Close codes, counted by code

```js title="metrics.js"
import { monitorEventLoopDelay } from 'node:perf_hooks';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

setInterval(() => {
  let maxBuffered = 0;
  for (const ws of wss.clients) {
    maxBuffered = Math.max(maxBuffered, ws.bufferedAmount);
  }
  gauge('ws.connections', wss.clients.size);
  gauge('ws.buffered_bytes.max', maxBuffered);
  gauge('eventloop.delay_p99_ms', loopDelay.percentile(99) / 1e6);
  loopDelay.reset();
}, 10_000);
```

Here `gauge` stands in for whatever metrics client you use. Close codes are the cheapest diagnostic on the list. A rise in 1006, which means the connection ended without a close frame, usually points at the network or a proxy, and it also includes your own `terminate()` calls, so count those separately at the call site. Spikes in 1001 should line up with deploys.

Presence is the part I don't have a clean answer for. Knowing whether a user is online means either a heartbeat-driven write to a shared store for every connection, which turns connection count into write load, or a key with a TTL that is wrong for as long as the TTL. Which error is acceptable is a product decision, and I don't have a design that removes the trade.
