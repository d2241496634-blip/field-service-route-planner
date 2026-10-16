# Field Service Route Planner — prototype

A reproducible scheduling and customer-backfill core prepared for an Agent Market bid. **This is a pre-award prototype, not a live listed agent.** No previous paid-client track record is claimed.

## Run

Node.js 22 or newer; no dependencies or installation needed:

```sh
node --test
node demo.mjs
```

The default demo generates a [one-day report](examples/day-report.md) and a [one-week report](examples/week-report.md), plus JSON input/results. Their customers, jobs, locations and drive times are **fictional**. They exercise the algorithm; they are not real-world performance or routing-provider evidence.

A separate [road integration report](examples/road-report.md) uses a real Geoapify response retrieved on 16 October 2026 between five public coordinates in central Berlin. Its 18 jobs, 3 crews and 200 customers remain fictional. [Provenance and matrix](examples/road-provenance.json) and the [schedule CSV](examples/road-schedule.csv) are provided. One 5×5 matrix request was made; no customer data, payment, or outreach was sent. This validates the road-time adapter, not a hosted agent or live customer service.

The newer [CSV integration report](examples/csv-road-report.md) runs the complete CSV → address validation → road routing → schedule pipeline. It includes a real, high-confidence public-building geocode and a 6×6 directional road matrix retrieved at `2026-10-16T07:34:25.526Z`. All 18 fictional jobs were scheduled for 3 fictional crews, with 3 gaps; the input has 200 fictional customers. [Inputs](examples/csv-input), [recorded road matrices](examples/csv-road-matrices.json), [geocode](examples/csv-road-geocode.json), and [result](examples/csv-road-result.json) make the run reproducible without further API calls in the tests. Broad/ambiguous matches were rejected rather than silently accepted.

## Implemented

- Every input job row appears in a route or the reasoned unassigned list, including malformed/duplicate rows.
- Full service visits and return travel fit the crew shift; required skills and full-visit time windows are enforced.
- Deterministic constrained insertion and bounded relocation; feasible input-order baseline comparison. Coverage differences are disclosed rather than counted as travel savings. No optimality claim.
- All original-route gaps of at least 30 minutes after direct travel are enumerated. Each proposed insertion preserves the start of every later appointment.
- Customer opt-outs propagate across duplicate IDs, emails, phones and matching name/address identities. Conflicting duplicate data is held for review.
- Due evidence must be an explicit due date, a provided last-service date plus provided recurrence interval, or a dated open quote. No standard service interval is guessed. Quote-based recommendations have lower confidence.
- Ranked alternatives include an unsent draft. There is no email, SMS or customer-contact capability.
- Strict CSV import helpers, explicit local-day time handling, bounded input sizes, and spreadsheet formula escaping on export.

## Normalized core input contract

`plan({ jobs, crews, customers, matrix, routing, minimumGapMinutes })` accepts normalized records. Times are minutes since midnight in the buyer-selected local timezone. Overnight shifts must be split by date. CSV helpers accept `HH:MM`.

| CSV | Required columns | Optional evidence / fields |
|---|---|---|
| jobs | id, date, location, duration, windowStart, windowEnd, skills | customerId |
| crews | id, date, location, start, end, skills | endLocation |
| customers | id, location, duration, skills | name, address, email, phone, doNotContact, optOut, lastServiceDate, intervalDays, dueDate, openQuote, quoteDate, windowStart, windowEnd, service |

`skills` is a semicolon-separated list; an empty list explicitly means no skill restriction. Dates are ISO `YYYY-MM-DD`. This low-level contract takes resolved location keys. The upload pipeline below accepts addresses/coordinates and resolves them. Missing due evidence excludes a customer from backfill; it does not exclude the buyer's explicitly booked jobs. Input caps: 150 jobs, 70 crew-day rows, 500 customer rows.

The matrix is directional, in minutes, indexed by location keys. Missing/unreachable pairs are infeasible, never zero. `routing` records `provider` and `kind` (`synthetic` or `road`). The caller is responsible for truthful provenance. Production results must retain the provider response/time and use real road estimates. The bundled fixtures deliberately declare `synthetic`.

## Upload pipeline and operating controls

See [OPERATIONS.md](OPERATIONS.md) for exact CSV columns and execution. `request.json` requires the planning dates, IANA timezone, country filter and explicit Geoapify-processing agreement. Jobs and crews need addresses or longitude/latitude; customer uploads require explicit opt-out and do-not-contact columns. Unknown/empty contact flags hold the whole identity group for review.

The pipeline uses only building/amenity geocodes with confidence ≥0.9 and a full match, rejects materially different plausible matches, checks a local service radius, and supports rectangular matrix batches. Customer contact data and service history never go to the map provider. Geometry selects up to 12 nearby candidates per gap; actual schedule times and feasibility always use road times. Cached road pairs may cover additional customers. This bounded search does not claim the globally best backfill.

Map calls reserve credits in an atomic on-disk ledger before network access, at ≤1 request per 1.1 seconds. Failures keep their reservation. Completed matrices are accounted using the published distance formula. The default cutoff is 2,000 reserved/accounted credits and 400 requests in any rolling 24 hours, below the current 3,000-credit free allowance. Unexpected cost freezes further calls. This is a conservative local estimate, not a provider-enforced billing cap; pricing changes or outside use of the same key are not automatically observable. No billing, upgrade or purchasing capability exists.

The assignment worker supports attachment size/checksum validation, per-assignment caches, idempotent progress messages, private CSV uploads, formal Markdown submission, fresh status checks before delivery and durable uncertain-outcome handling. An ambiguous upload is held for review; an ambiguous submit is reconciled against the latest stored deliverable instead of blindly retried. A request for changes without changed input files also needs operator review. Standard bounties are held for operator handling; automated processing is limited to enabled, positive-USDC instant hires.

Real platform validation: one private fictional CSV was uploaded through the documented direct-storage flow, and the platform's completion receipt matched its SHA-256 and byte count. No paid assignment was created, no buyer was messaged, and no formal deliverable was submitted. Complete paid-lifecycle behavior is tested with mocks and still needs a real funded assignment for platform acceptance.

On 16 October 2026 the worker successfully completed one live **observe-only** assignment poll (zero assignments). It is **not running in the background**. A background-launch attempt was rejected by the execution policy; no persistent process or startup task was installed. This is not a live listing or a 24/7 availability claim.

## Remaining before a live service

1. Validate deployment/persistent operation and recovery on the authorized host. Add final retention cleanup and owner-attention handling for missing input, text-only revisions, provider changes and uncertain uploads.
2. Complete the buyer-facing listing, price/capacity and outage policy, then publish in Automation after the worker is ready.
3. Validate the formal paid delivery/revision lifecycle on an actual assigned job. A code repository or mock success is not a substitute for the required live listing and buyer acceptance.

Geoapify is the proposed production map provider. Its [pricing page](https://www.geoapify.com/pricing/) states a free commercial-production tier with 3,000 credits/day and no credit card. Usage must be capped below that allowance; overage is not authorized. [Matrix documentation](https://apidocs.geoapify.com/docs/route-matrix/) specifies directional road times, 1,000 cells per ordinary request, and credit calculations. A Free project has now been provisioned and used for the small road smoke test; credentials are outside this repository. Names, contact details and service histories would remain in the worker; only necessary addresses/coordinates would go to the map provider with the buyer's disclosed agreement. Provider attribution accompanies the road report.

`road-demo.mjs` requires `GEOAPIFY_API_KEY` only for its first request, caches the result under ignored `state/`, locks concurrent runs, and allows at most one uncached 5×5 request per UTC day, including failures. New requests also use the shared service quota ledger. The first historical request has been conservatively seeded into that ledger as a 500-credit reservation. Re-running from cache sends no request. The low-level map adapter alone is not an unmetered public endpoint; use `MapsService` with the shared ledger.

The worker uses outbound-only polling, per the [Agent Market self-hosted guide](https://docs.market.near.ai/guides/self-hosted-agents.md). No inbound port, paid host, startup service or computer power-setting change is required by the implementation.

## Interpretation and limits

- Suggestion lists are alternatives. Do not book them all; rerun after choosing one. A customer can appear in several alternative gaps.
- Greedy insertion is not an exact vehicle-routing solver. An unassigned result can mean the heuristic did not find a solution, not that one is mathematically impossible.
- Baseline and optimized routes include the depot return. Empty crew-day routes are retained, exposing a full-day gap. Workload balance and breaks are not modeled yet.
- Real drive times will remain estimates, with traffic and delays outside the model. Service windows must include sufficient operational buffers.
- No CRM connectors, outreach sending, wallet access, payment processing or real customer data are included.

## Checks

The tests independently check row coverage, timing, skills, return travel, all gap positions and suggestion feasibility; they include 40 seeded scenarios, duplicate opt-out propagation, malformed dates, unreachable routes, impossible windows, CSV parsing and formula escaping. Run `node --test` for current results.
