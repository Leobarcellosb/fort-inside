import { NewEventForm } from "@/components/features/admin/NewEventForm";

export default function NewEventPage() {
  return (
    <div className="min-h-screen bg-background p-4 lg:p-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-8 space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">Admin</p>
          <h1 className="font-display text-2xl text-foreground">Novo evento</h1>
        </div>
        <NewEventForm />
      </div>
    </div>
  );
}
