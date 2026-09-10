export default function SaleLoading() {
  return (
    <main className="min-h-screen bg-white px-4 py-8 sm:px-6" aria-busy="true">
      <p className="sr-only" role="status">
        Chargement de l’annonce…
      </p>
      <div className="mx-auto max-w-7xl" aria-hidden="true">
        <div className="h-4 w-20 animate-pulse rounded-md bg-muted" />
        <div className="mt-4 h-8 w-2/3 animate-pulse rounded-md bg-muted" />
        <div className="mt-2 h-4 w-1/2 animate-pulse rounded-md bg-muted" />
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="h-96 animate-pulse rounded-lg bg-muted" />
            <div className="h-40 animate-pulse rounded-lg bg-muted" />
          </div>
          <div className="h-48 animate-pulse rounded-lg bg-muted" />
        </div>
      </div>
    </main>
  );
}
