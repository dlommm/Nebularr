import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DataTable<TData>({
  columns,
  data,
  className,
  pageSize = 10,
  emptyMessage = "No rows.",
}: {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  className?: string;
  pageSize?: number;
  emptyMessage?: string;
}): JSX.Element {
  const [page, setPage] = useState(0);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;
  const start = page * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  return (
    <div className={cn("w-full space-y-3", className)}>
      <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="border-white/10 hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-xs font-medium text-muted-foreground">
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row) => (
                <TableRow key={row.id} className="border-white/5 hover:bg-white/[0.04]">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="text-sm">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > pageSize ? (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>
            {start + 1}-{Math.min(start + pageSize, rows.length)} of {rows.length}
          </span>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page <= 0}>
            Prev
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
