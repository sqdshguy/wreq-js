---

title: Benchmarking
description: Internal benchmark runner documentation for local and AWS perf checks.
noindex: true
---

# Benchmarking

This repo includes a local benchmark runner that starts a local HTTP server and measures request throughput across multiple samples, reporting a 95% confidence interval so you can tell whether a change is above the noise floor.

These results are intentionally scoped to local HTTP throughput. They do **not** measure TLS impersonation overhead, proxy tunneling behavior, WAN latency, or anti-bot challenge handling. Treat them as a microbenchmark for request-path regressions, not production end-to-end latency.

## Run

Build + run:

```bash
npm run bench
```

Run (assumes you already built `dist/` and the native addon):

```bash
npm run bench:run
```

Quick sanity run:

```bash
npm run bench:quick
```

Write results to JSON (useful for comparing runs):

```bash
npm run bench:run -- --json ./bench-results.json
```

## Key options

```bash
npm run bench:run -- --duration-ms 2000 --samples 15 --warmup 3 --concurrency 32
```

- `--duration-ms`: Longer samples reduce noise.
- `--samples`: More samples reduce confidence interval width.
- `--concurrency`: Lower if you suspect the local server or your machine is saturated.

## Scenarios

The default run includes:

- `wreq.session.get.small` - Session fetch, tiny response body (connection reuse).
- `wreq.session.get.4kb` - Session fetch, 4KB response body.
- `wreq.session.post.32b` - Session fetch, 32B POST body (server validates length).
- `wreq.isolated.get.small` - Isolated `fetch()` (no connection reuse).
- `node.fetch.get.small` - Node's built-in `fetch()` for sanity/reference.

Select a subset:

```bash
npm run bench:run -- --scenario wreq.session.get.small --scenario wreq.session.get.4kb
```

## Making results comparable

- Run on the same machine, on AC power, with minimal background load.
- Prefer longer `--duration-ms` and more `--samples` until the reported CI margin is comfortably smaller than the improvement you’re targeting.
- Keep parameters constant when comparing optimizations.

## AWS isolated perf runs (recommended for low-noise gating)

If you do not want to benchmark on your laptop/network, use the AWS CLI harness:

1. Create the EC2 instance profile once (requires IAM permissions):

```bash
./scripts/aws-perf/setup-iam.sh
```

2. Run base vs head comparison on an ephemeral EC2 runner (Spot by default, auto-terminates):

```bash
./scripts/aws-perf/ec2-compare.sh
```

Note: the runner clones from `origin` by default, so both refs must exist in the remote repository (push your branch/commit first if needed).
Default region is `us-west-2`; pass `--region <aws-region>` to override.
Use `--cheapest-region` to auto-pick the cheapest on-demand region for your selected instance type.

The script:

- Launches a short-lived EC2 instance with SSM (no inbound SSH required).
- Runs the same benchmark scenarios for `--base-ref` and `--head-ref` on the same host.
- Produces `tmp/aws-perf/<run-id>/summary.json` with per-scenario deltas and a pass/fail gate.
- Produces `tmp/aws-perf/<run-id>/pricing.json` with on-demand and recent spot pricing info.
- Terminates the instance automatically unless `--keep-instance` is passed.

Useful options:

- `--on-demand` to avoid Spot interruptions.
- `--instance-type c6i.large` (default) for low cost and stable throughput.
- `--threshold-pct 5` to set the regression gate.
- `--scenarios 'wreq.session.get.small;wreq.session.get.4kb;wreq.isolated.get.small'` to limit scope.
- `--cheapest-region` to choose the cheapest on-demand region automatically.

Pricing-only check (no EC2 launch):

```bash
./scripts/aws-perf/ec2-compare.sh --instance-type c6i.large --cheapest-region --pricing-only
```

Safety cleanup:

```bash
./scripts/aws-perf/cleanup-stale.sh
```

This terminates old perf instances tagged with expired TTL metadata.
