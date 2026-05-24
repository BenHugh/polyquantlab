"""ARQ worker — runs backtest jobs out-of-band from the FastAPI server.

Why a separate process:
  * Long-running async tasks shouldn't share an event loop with
    user-facing HTTP handlers — a CPU-bound replay on one job would
    starve concurrent /v1/markets requests of the API server's loop.
  * Worker count scales independently. If backtests become the
    bottleneck we add `--workers N` and the queue depth absorbs it.
  * Crash isolation: a worker that OOMs on a malformed strategy
    doesn't take the API down.

Launch via `arq worker.WorkerSettings`.
"""
