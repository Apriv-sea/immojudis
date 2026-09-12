"""Meter predictions without retaining prompts, outputs, logs or credentials."""
from __future__ import annotations

import math
import os
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg.types.json import Jsonb

from src.config import load_settings

PINNED_MODEL = 'zsxkib/qwen2-7b-instruct:5324178307f5ec0239326b429d6b64ae338cd6b51fbe234402a55537a9998ac4'
RATE_SOURCE = 'https://replicate.com/pricing#hardware; L40S 0.000975 USD/s; checked 2026-09-12'


class PipelineBudgetExhausted(RuntimeError):
    def __init__(self, message: str):
        super().__init__(message)
        now = datetime.now(UTC)
        self.next_attempt_at = (now+timedelta(days=1)).replace(hour=0,minute=0,second=0,microsecond=0) if 'Daily' in message else now+timedelta(minutes=30)


def defer_budget_jobs(jobs: list, error: PipelineBudgetExhausted) -> None:
    from src.storage.supabase_client import _postgres_connect
    with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
        for job in jobs:
            db.execute("""update public.auction_enrichment_jobs set status='queued',locked_at=null,
              attempt_count=greatest(0,attempt_count-1),next_attempt_at=%s,last_error=%s,updated_at=now()
              where id=%s and status='running' and attempt_count=%s""",
              (error.next_attempt_at,str(error),job['id'],job['attempt_count']))


def reserve_prediction(model: str) -> str | None:
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    if not run_id:
        return None
    from src.storage.supabase_client import _postgres_connect
    try:
        with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
            return str(db.execute('select public.reserve_pipeline_prediction(%s,%s)',(run_id,model)).fetchone()[0])
    except psycopg.errors.RaiseException as exc:
        message = exc.diag.message_primary or str(exc)
        if 'budget exhausted' in message:
            raise PipelineBudgetExhausted(message) from exc
        raise


def record_prediction(prediction: dict, *, reservation: str | None = None) -> None:
    run_id = os.getenv('PIPELINE_AUTONOMOUS_RUN_ID')
    if not run_id:
        return
    from src.storage.supabase_client import _postgres_connect
    metrics = {key:value for key,value in (prediction.get('metrics') or {}).items()
               if key in {'predict_time','total_time','input_token_count','output_token_count'}
               and isinstance(value,(int,float)) and math.isfinite(value) and value>=0}
    seconds = metrics.get('predict_time')
    cost = seconds*0.000975 if seconds is not None else None
    with _postgres_connect(str(load_settings()['supabase_db_url'])) as db:
        db.execute("""update public.auction_pipeline_usage set prediction_id=coalesce(%s,prediction_id),
          status=%s,metrics=%s,estimated_usd=case when model=%s then %s else null end,
          rate_source=%s,updated_at=now() where run_id=%s and (id=%s or prediction_id=%s)""",
          (prediction.get('id'),prediction.get('status') or 'unknown',Jsonb(metrics),PINNED_MODEL,cost,
           RATE_SOURCE,run_id,reservation,prediction.get('id')))
