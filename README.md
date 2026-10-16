# Field Service Route Planner — prototype

A reproducible scheduling and customer-backfill core prepared for an Agent Market bid. **This is a pre-award prototype, not a live listed agent.** No previous paid-client track record is claimed.

## Run

Node.js 22 or newer; no dependencies or installation needed:

```sh
node --test
node demo.mjs
```

The demo generates a [one-day report](examples/day-report.md) and a [one-week report](examples/week-report.md), plus JSON input/results. All customers, jobs, locations and drive times are **fictional**. They exercise the algorithm; they are not real-world performance or routing-provider evidence.

## Implemented

- Every input job row appears in a route or the reasoned unassigned list, including malformed/duplicate rows.
- Full service visits and return travel fit the crew shift; required skills and full-visit time windows are enforced.
- Deterministic constrained insertion and bounded relocation; feasible input-order baseline comparison. Coverage differences are disclosed rather than counted as travel savings. No optimality claim.
- All original-route gaps of at least 30 minutes after direct travel are enumerated. Each proposed insertion preserves the start of every later appointment.
- Customer opt-outs propagate across duplicate IDs, emails, phones and matching name/address identities. Conflicting duplicate data is held for review.
- Due evidence must be an explicit due date, a provided last-service date plus provided recurrence interval, or a dated open quote. No standard service interval is guessed. Quote-based recommendations have lower confidence.
- Ranked alternatives include an unsent draft. There is no email, SMS or customer-contact capability.
- Strict CSV import helpers, explicit local-day time handling, bounded input sizes, and spreadsheet formula escaping on export.

## Current input contract

`plan({ jobs, crews, customers, matrix, routing, minimumGapMinutes })` accepts normalized records. Times are minutes since midnight in the buyer-selected local timezone. Overnight shifts must be split by date. CSV helpers accept `HH:MM`.

| CSV | Required columns | Optional evidence / fields |
|---|---|---|
| jobs | id, date, location, duration, windowStart, windowEnd, skills | customerId |
| crews | id, date, location, start, end, skills | endLocation |
| customers | id, location, duration, skills | name, address, email, phone, doNotContact, optOut, lastServiceDate, intervalDays, dueDate, openQuote, quoteDate, windowStart, windowEnd, service |

`skills` is a semicolon-separated list; an empty list explicitly means no skill restriction. Dates are ISO `YYYY-MM-DD`. `location` is currently a resolved routing-location key, not an address geocoder. Missing due evidence excludes a customer from backfill; it does not exclude the buyer's explicitly booked jobs. Input caps: 150 jobs, 70 crew-day rows, 500 customer rows.

The matrix is directional, in minutes, indexed by location keys. Missing/unreachable pairs are infeasible, never zero. `routing` records `provider` and `kind` (`synthetic` or `road`). The caller is responsible for truthful provenance. Production results must retain the provider response/time and use real road estimates. The bundled fixtures deliberately declare `synthetic`.

## Remaining before a live service

1. Address geocoding with ambiguity review and routing integration tested against real provider responses; no silent straight-line substitute.
2. Durable assignment polling, attachment import, client messages and formal submissions; restart/revision/timeout handling and isolated per-buyer data.
3. Always-available hosting validation, usage caps and quota accounting, privacy/retention configuration, and a clear outage policy.
4. Publish a priced Automation listing only once the worker and map integration pass an end-to-end acceptance run. The current code is not that acceptance run.

Geoapify is the proposed production map provider. Its [pricing page](https://www.geoapify.com/pricing/) states a free commercial-production tier with 3,000 credits/day and no credit card. Usage must be capped below that allowance; overage is not authorized. [Matrix documentation](https://apidocs.geoapify.com/docs/route-matrix/) specifies directional road times, 1,000 cells per ordinary request, and credit calculations. An account/API key has not been provisioned or used. Names, contact details and service histories would remain in the worker; only necessary addresses/coordinates would go to the map provider with the buyer's disclosed agreement. Provider attribution must accompany resulting reports.

Hosting is not provisioned. A small Node worker can run with outbound-only polling on a persistent host, per the [Agent Market self-hosted guide](https://docs.market.near.ai/guides/self-hosted-agents.md). This repository does not claim 24/7 availability, start a background process, install a service, or modify the computer's power settings.

## Interpretation and limits

- Suggestion lists are alternatives. Do not book them all; rerun after choosing one. A customer can appear in several alternative gaps.
- Greedy insertion is not an exact vehicle-routing solver. An unassigned result can mean the heuristic did not find a solution, not that one is mathematically impossible.
- Baseline and optimized routes include the depot return. Empty crew-day routes are retained, exposing a full-day gap. Workload balance and breaks are not modeled yet.
- Real drive times will remain estimates, with traffic and delays outside the model. Service windows must include sufficient operational buffers.
- No CRM connectors, outreach sending, wallet access, payment processing or real customer data are included.

## Checks

The tests independently check row coverage, timing, skills, return travel, all gap positions and suggestion feasibility; they include 40 seeded scenarios, duplicate opt-out propagation, malformed dates, unreachable routes, impossible windows, CSV parsing and formula escaping. Run `node --test` for current results.
