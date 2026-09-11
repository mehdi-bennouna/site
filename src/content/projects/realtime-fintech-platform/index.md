---
title: Real-time fintech platform
description: Backend, payments, web apps and infrastructure for a high-throughput, real-time fintech platform serving thousands of active users.
date: 2024-08-01
tags:
  - typescript
  - postgresql
  - redis
  - websockets
  - devops
  - observability
---

I worked on this platform as a Full-Stack and DevOps engineer from August 2024 to September 2026. It's a real-time, high-throughput fintech product, and I can't say more about what it does. This page covers the engineering side.

## Backend

The backend APIs were built with Express and Fastify, using Prisma and Kysely on top of PostgreSQL and MongoDB. They scaled with the platform as it grew to thousands of active users.

Real-time features ran over WebSockets backed by Redis. Background work went through BullMQ queues, and authentication used JWT and Zitadel SSO.

## Payment engine

I engineered the core payment engine. It's built around a fully auditable balance ledger that records every movement of user funds, so any balance can be traced back to the transactions that produced it.

## Web apps

I built the user-facing web app as well as the back-office and admin apps, using Next.js, React, Tailwind and TanStack, with a polished, mobile-like UX across all of them.

## Automation and testing

Playwright did a lot of work here. I first used it for internal workflow automation and data scraping tools, then extended it into QA testing across the platform's web apps to improve coverage.

## Infrastructure and observability

I owned DevOps end-to-end:

- Deployments were automated with Docker, Ansible and GitLab CI across multiple VPS instances.
- Secrets were managed with HashiCorp Vault.
- Every service had observability through OpenTelemetry and Grafana, which improved how quickly incidents were detected and how many were
  prevented.
