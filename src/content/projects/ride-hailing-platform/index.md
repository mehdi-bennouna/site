---
title: Sahla ride-hailing platform
description: Backend services for a ride-hailing platform spanning five apps and 25k drivers, with real-time matching, live tracking and a
    double-entry ledger.
date: 2023-12-01
tags:
  - nodejs
  - redis
  - socket-io
  - geospatial
  - payments
  - event-driven
---

I worked on Sahla's ride-hailing platform as a full-stack engineer from December 2023 to August 2024. The platform spans five apps (rider, driver, back-office, rider support and customer support) and supports a base of 25k drivers. I built the backend services behind them.

## Matching and live tracking

Rider-driver matching and live position tracking used Redis Geo, Mapbox and Google Maps, covering geospatial search, routing and ETAs.

## Real-time at scale

The real-time services ran on Socket.IO with Redis pub/sub. I scaled them across distributed servers while keeping ride state and driver locations in sync.

## Payments and the ledger

Payment management covered two flows: local digital payments, and cash rides confirmed by the driver. It handled commissions, driver balances and reconciliation.

Underneath it is a double-entry ledger that acts as the financial source of truth. Every ride, commission and payout has a balanced, auditable record.

## Compliance

I implemented the regulatory compliance work to meet local transport and data-protection requirements:

- data-retention policies
- driver verification workflows
- payment record-keeping

## Architecture

I designed an event-driven architecture that delivers multi-channel notifications reliably and keeps services decoupled as the platform grows.

## Observability and internal tools

I set up logging and observability across the whole stack. I also built internal web tools that helped the team debug production issues and test faster:

- a ledger viewer
- a queue inspector
- a mock driver simulator
