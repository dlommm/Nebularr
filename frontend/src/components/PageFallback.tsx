export function PageFallback(): JSX.Element {
  return (
    <div className="page-fallback" aria-busy="true" aria-label="Loading page">
      <div className="page-fallback-inner">
        <span className="page-fallback-dot" />
        <span className="page-fallback-text">Loading…</span>
      </div>
    </div>
  );
}
