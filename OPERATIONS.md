# Route planner operations — pre-launch

Node.js 22+; no dependencies. The current service has not been published. Use `node --test` for offline checks, including replay of recorded real-provider data. Files under `private/` and `state/` are ignored by Git.

## Four upload files

All files are UTF-8; each CSV is at most 2 MiB. Export spreadsheets as CSV. No macros, XLSX files, remote links or arbitrary code are evaluated.

`request.json`:

```json
{
  "startDate": "2026-10-19",
  "endDate": "2026-10-25",
  "timezone": "America/New_York",
  "countryCode": "us",
  "minimumGapMinutes": 30,
  "mapProcessingConsent": true
}
```

Only set `mapProcessingConsent` to true if the buyer agrees that necessary addresses/coordinates may be processed by Geoapify. Names, contact details and service history stay in the assignment's local processing context. The [public demonstration](examples/csv-input) is fictional and grants this permission only for its public locations.

| File | Required columns | Optional columns |
|---|---|---|
| jobs.csv | id, date, duration, windowStart, windowEnd, skills; plus address OR longitude and latitude | customerId |
| crews.csv | id, date, start, end, skills; plus address OR longitude and latitude | endAddress OR endLongitude and endLatitude |
| customers.csv | id, duration, skills, doNotContact, optOut; plus address OR longitude and latitude | name, email, phone, lastServiceDate, intervalDays, dueDate, openQuote, quoteDate, windowStart, windowEnd, service |

Times are local `HH:MM`, dates `YYYY-MM-DD`, skills separated by semicolons. The complete service must fit the job window; return travel must fit the shift. Split overnight shifts into separate date rows. Planning periods are 1–7 days. Local service locations must be within 150 km of the first crew start; multi-region planning requires review. The listed timezone is never inferred from the host IP.

Customer contact flags must explicitly be true/false (also yes/no, y/n, 1/0). Empty/unknown flags hold the identity group for review. Any opt-out suppresses the whole linked duplicate group. Contradictory records are not silently merged. No recurrence interval is invented. A dated open quote is weaker evidence and is labeled medium confidence.

For backfill, the 12 nearest eligible records per gap form the initial road-check shortlist. Existing road pairs can cover additional records. Rank feasible suggestions by evidence confidence, extra drive, overdue days, then stable ID. Suggestions are alternatives; select one, rerun, and confirm the customer before booking.

## Local execution

Inject `GEOAPIFY_API_KEY` into the process environment from encrypted storage. Do not put it in this repository, command-line arguments, a CSV, or logs.

```sh
node run-plan.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY state/service
```

Use a unique private output directory per assignment. It contains `report.md`, `schedule.csv`, `result.json` and its own private map cache. Do not reuse one buyer's cache for another buyer. One exclusive process lease protects the shared quota ledger; do not run a CLI planner concurrently with the worker against that ledger. Do not delete or reset quota entries to force more requests.

The ledger tracks rolling 24-hour reservations and completed costs, with a 2,000-credit/400-request cutoff and at least 1.1 seconds between requests. API timeouts leave reservations charged. Matrix estimates include a distance margin; a cost above it freezes requests for operator inspection. Large inputs or external use of the same key can require waiting. There is no paid fallback or unlimited-volume promise.

## Worker modes

`worker.mjs` requires `AGENT_API_TOKEN`, and `GEOAPIFY_API_KEY` when processing. The runtime config defaults to observation:

```json
{"processInstantHires": false, "manualJobIds": []}
```

```sh
node worker.mjs state/service state/worker-config.json --once
```

Without `--once`, the foreground process polls every 60 seconds. Removing `--once` does not register an OS service or make it restart after reboot. The current local deployment has only passed the single-cycle observation check; no ongoing process is running.

Set `processInstantHires: true` only after the listing, capacity, privacy/retention terms, operator handling and runtime validation are ready. The code then processes positive-USDC instant hires for this agent; standard bounty work and configured manual job IDs remain for the operator. Keep the build bounty separate from buyers hiring the completed route service: its required deliverable is a live listing URL, not a sample schedule.

The worker stores `heartbeat.json` and per-assignment state. `upload_pending`, `submit_pending`, `needs_review` and `operator_review` require attention. Do not erase them to retry. A submit with uncertain outcome is checked against the latest platform deliverable; no match means it remains held, not permission to repeat. The uploader currently pins the storage origin observed from the authenticated platform API (`https://t3.storageapi.dev`); changes require review. The bearer is never sent to storage.

Before manually removing a stale `process.lock`, inspect its PID and verify that exact worker has stopped. A lock file alone is not evidence of a live or dead process. To request a graceful stop, write JSON `true` to `state/service/stop.json`; the loop exits after current work, before its next poll. Reset it to `false` before a deliberate new launch.

## Pre-launch work still required

- Persistent runtime and restart/outage procedures verified on the user's authorized host.
- Buyer communication for missing input and natural-language revisions; current implementation records these for operator review.
- Retention cleanup and a visible retention policy. No buyer-private production data has been processed yet. Do not claim automatic deletion until implemented and verified.
- A public Automation listing and an actual funded delivery/acceptance check. Mock lifecycle tests and a private test upload do not establish buyer acceptance or earnings.

There is no email/SMS capability, customer-contact sender, wallet access, trading, mining, paid API upgrade, or power-setting control in this service.
