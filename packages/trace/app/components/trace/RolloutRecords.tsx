import type { RolloutDetail, RolloutRecordView } from "@gestalt/live-contracts";
import { FileJson2 } from "lucide-react";
import { formatTime, shortId } from "../../lib/format";
import { JsonDialog } from "./JsonDialog";
import { EmptyState } from "./StateViews";

export function RolloutRecords({ detail }: { detail: RolloutDetail }) {
  if (!detail.records.length) {
    return <EmptyState description="Immutable JSONL records appear here after the rollout writer commits them." title="No records" />;
  }
  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs leading-5 text-neutral-600">Records are append-only. Open one row to inspect its payload.</p>
        <span className="shrink-0 text-[11px] tabular-nums text-neutral-500">{detail.records.length} total</span>
      </div>
      <ol className="divide-y divide-neutral-200 overflow-hidden rounded-md bg-white ring-1 ring-neutral-200">
        {detail.records.map((record) => <RecordRow key={record.id} record={record} />)}
      </ol>
    </div>
  );
}

function RecordRow({ record }: { record: RolloutRecordView }) {
  return (
    <li className="flex min-w-0 items-center gap-3 px-3 py-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-600">
        <FileJson2 aria-hidden="true" size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words font-mono text-[11px] font-medium text-neutral-950">{record.type}</p>
        <p className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-neutral-500">
          <time dateTime={record.at}>{formatTime(record.at)}</time>
          {record.stateHash ? <span className="font-mono" title={record.stateHash}>{shortId(record.stateHash, 14)}</span> : null}
        </p>
      </div>
      <JsonDialog label="Open" title={`${record.type} · ${record.id}`} value={record} />
    </li>
  );
}
