import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2.js";
import Loader2 from "lucide-react/dist/esm/icons/loader-2.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import MailSearch from "lucide-react/dist/esm/icons/mail-search.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  createInformationAgentDraftClient,
  fetchFeatureEntitlements,
  fetchInformationAgentMissions,
  runInformationAgentActionClient,
} from "@/lib/client-api";
import { Link } from "@/lib/router-compat";
import type { InformationAgentMission } from "@/lib/information-agent";
import type { AuctionSale } from "@/lib/types";
import { listingContactEmail } from "@/lib/listing-evidence";

const STATUS_LABELS: Record<InformationAgentMission["status"], string> = {
  draft: "Brouillon à valider",
  approved: "Validée",
  sending: "Envoi en cours",
  sent: "Envoyée",
  subscribed: "Dossier mutualisé rejoint",
  replied: "Réponse enregistrée",
  completed: "Terminée",
  failed: "Envoi à reprendre",
  cancelled: "Annulée",
};

export function InformationRequestAgent({
  sale,
  previewOnly = false,
}: {
  sale: AuctionSale;
  previewOnly?: boolean;
}) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["information-agent", sale.id, user?.id ?? "anonymous"] as const;
  const [selectedMission, setSelectedMission] = useState<InformationAgentMission | null>(null);
  const [startNew, setStartNew] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState(() => listingContactEmail(sale));
  const [recipientName, setRecipientName] = useState(sale.lawyer_name ?? "");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [shareEmail, setShareEmail] = useState(false);
  const [replyText, setReplyText] = useState("");

  const entitlementsQuery = useQuery({
    queryKey: ["feature-entitlements", user?.id ?? "anonymous"],
    queryFn: fetchFeatureEntitlements,
    enabled: Boolean(user) && !loading && !previewOnly,
    staleTime: 5 * 60_000,
  });
  const missionsQuery = useQuery({
    queryKey,
    queryFn: () => fetchInformationAgentMissions({ saleId: sale.id }),
    enabled:
      Boolean(user) &&
      !loading &&
      !previewOnly &&
      entitlementsQuery.data?.plan.features.informationAgent === "included",
    staleTime: 30_000,
  });
  const latestMission = selectedMission ?? missionsQuery.data?.missions[0] ?? null;
  const activeMission = startNew ? null : latestMission;

  useEffect(() => {
    if (!activeMission) return;
    setRecipientEmail(activeMission.recipientEmail);
    setRecipientName(activeMission.recipientName ?? "");
    setSubject(activeMission.subject);
    setBodyText(activeMission.bodyText);
  }, [activeMission]);

  const createMutation = useMutation({
    mutationFn: () =>
      createInformationAgentDraftClient({
        data: {
          saleId: sale.id,
          recipientEmail,
          recipientName: recipientName || undefined,
        },
      }),
    onSuccess: async (response) => {
      setSelectedMission(response.mission);
      setStartNew(false);
      setSubject(response.mission.subject);
      setBodyText(response.mission.bodyText);
      setApprovalConfirmed(false);
      setShareEmail(false);
      toast.success(
        response.mission.status === "subscribed"
          ? "Une enquête existe déjà : vous venez de rejoindre son suivi."
          : "Brouillon préparé. Relisez-le avant tout envoi.",
      );
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });

  const actionMutation = useMutation({
    mutationFn: runInformationAgentActionClient,
    onSuccess: async (response) => {
      const mission = response.missions[0];
      if (mission) setSelectedMission(mission);
      setApprovalConfirmed(false);
      setShareEmail(false);
      toast.success(
        mission?.status === "sent"
          ? "Email envoyé au professionnel."
          : mission?.status === "subscribed"
            ? "Vous suivez maintenant l’enquête déjà ouverte, sans nouvel email."
            : "Enquête mise à jour.",
      );
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });

  const replyMutation = useMutation({
    mutationFn: () => {
      if (!activeMission) throw new Error("Enquête introuvable.");
      return runInformationAgentActionClient({
        data: { action: "record_reply", missionId: activeMission.id, bodyText: replyText },
      });
    },
    onSuccess: async (response) => {
      const mission = response.missions[0];
      if (mission) setSelectedMission(mission);
      setReplyText("");
      toast.success("Réponse enregistrée dans l'enquête.");
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: showError,
  });

  const locked = entitlementsQuery.data?.plan.features.informationAgent === "locked";
  const quota = missionsQuery.data?.quota;
  const canSend =
    activeMission &&
    (activeMission.status === "draft" || activeMission.status === "failed") &&
    approvalConfirmed &&
    shareEmail &&
    recipientEmail.trim() &&
    subject.trim() &&
    bodyText.trim();
  const busy = createMutation.isPending || actionMutation.isPending || replyMutation.isPending;
  const requestableStatus = activeMission?.status === "draft" || activeMission?.status === "failed";
  const canRecordReply = activeMission?.status === "sent" || activeMission?.status === "replied";
  const includedGapLabels = useMemo(
    () => activeMission?.missingInformation.map(gapLabel) ?? [],
    [activeMission?.missingInformation],
  );
  const sharedFacts = missionsQuery.data?.facts ?? [];

  return (
    <section
      id="information-agent"
      aria-labelledby="information-agent-title"
      className="scroll-mt-36 overflow-hidden rounded-2xl border border-gold/25 bg-[linear-gradient(135deg,rgba(246,240,226,0.95),rgba(255,255,255,0.98))] shadow-sm"
    >
      <div className="border-b border-gold/20 px-5 py-5 sm:px-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#8a5b24]">
              <Bot className="h-4 w-4" />
              Agent IA supervisé · Analyse
            </div>
            <h2
              id="information-agent-title"
              className="mt-2 font-display text-2xl text-foreground sm:text-3xl"
            >
              Demander les informations qui manquent
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              ImmoJudis prépare un email ciblé à l’intermédiaire de l’annonce pour demander pièces,
              photos et précisions. Une enquête déjà ouverte est mutualisée entre utilisateurs afin
              d’éviter les sollicitations en double.
            </p>
          </div>
          {quota?.limit != null ? (
            <div className="shrink-0 rounded-full border border-gold/25 bg-white px-3 py-1.5 text-xs font-semibold text-foreground">
              {quota.remaining} / {quota.limit} enquêtes disponibles
            </div>
          ) : null}
        </div>
      </div>

      <div className="p-5 sm:p-7">
        {previewOnly ? (
          <AgentPreview />
        ) : !user && !loading ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Connectez-vous pour préparer une enquête.
            </p>
            <Button asChild>
              <Link to="/login">Se connecter</Link>
            </Button>
          </div>
        ) : locked ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <LockKeyhole className="mt-0.5 h-5 w-5 text-gold-soft" />
              <div>
                <p className="font-semibold text-foreground">
                  Fonctionnalité réservée au plan Analyse
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Le plan inclut jusqu’à 3 enquêtes validées sur une période glissante de 30 jours.
                </p>
              </div>
            </div>
            <Button asChild>
              <Link to="/accompagnement">Découvrir Analyse</Link>
            </Button>
          </div>
        ) : entitlementsQuery.isLoading || missionsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement de l’agent…
          </div>
        ) : entitlementsQuery.isError || missionsQuery.isError ? (
          <div
            role="alert"
            className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            <p>
              Impossible de vérifier les enquêtes existantes. Réessayez avant de préparer une
              nouvelle demande.
            </p>
            <Button
              variant="outline"
              className="h-auto min-h-9 max-w-full whitespace-normal"
              disabled={entitlementsQuery.isFetching || missionsQuery.isFetching}
              onClick={async () => {
                const access = await entitlementsQuery.refetch();
                if (access.data?.plan.features.informationAgent === "included") {
                  await missionsQuery.refetch();
                }
              }}
            >
              Réessayer le chargement
            </Button>
          </div>
        ) : !activeMission ? (
          <DraftStarter
            recipientEmail={recipientEmail}
            recipientName={recipientName}
            onEmailChange={setRecipientEmail}
            onNameChange={setRecipientName}
            onCreate={() => createMutation.mutate()}
            busy={busy}
          />
        ) : (
          <div className="grid gap-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-bold text-foreground shadow-sm">
                  <CheckCircle2 className="h-3.5 w-3.5 text-gold-soft" />
                  {STATUS_LABELS[activeMission.status]}
                </span>
                {includedGapLabels.length ? (
                  <span className="text-xs text-muted-foreground">
                    {includedGapLabels.length} manque{includedGapLabels.length > 1 ? "s" : ""} ciblé
                    {includedGapLabels.length > 1 ? "s" : ""}
                  </span>
                ) : null}
              </div>
              {!requestableStatus ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-gold-soft underline-offset-4 hover:underline"
                  onClick={() => {
                    setStartNew(true);
                    setSelectedMission(null);
                    setSubject("");
                    setBodyText("");
                  }}
                >
                  Préparer une nouvelle enquête
                </button>
              ) : null}
            </div>

            {includedGapLabels.length ? (
              <div className="flex flex-wrap gap-2">
                {includedGapLabels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-gold/20 bg-white px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}

            {requestableStatus ? (
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nom du destinataire" htmlFor="agent-recipient-name">
                    <input
                      id="agent-recipient-name"
                      value={recipientName}
                      onChange={(event) => setRecipientName(event.target.value)}
                      maxLength={180}
                      className={fieldClassName}
                    />
                  </Field>
                  <Field label="Email du destinataire" htmlFor="agent-recipient-email">
                    <input
                      id="agent-recipient-email"
                      type="email"
                      value={recipientEmail}
                      onChange={(event) => setRecipientEmail(event.target.value)}
                      maxLength={320}
                      required
                      className={fieldClassName}
                    />
                  </Field>
                </div>
                <Field label="Objet" htmlFor="agent-subject">
                  <input
                    id="agent-subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    maxLength={200}
                    className={fieldClassName}
                  />
                </Field>
                <Field label="Message à relire" htmlFor="agent-body">
                  <textarea
                    id="agent-body"
                    value={bodyText}
                    onChange={(event) => setBodyText(event.target.value)}
                    maxLength={8000}
                    rows={14}
                    className={`${fieldClassName} resize-y leading-relaxed`}
                  />
                </Field>

                <div className="grid gap-3 rounded-xl border border-gold/20 bg-white/80 p-4 text-sm">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={approvalConfirmed}
                      onChange={(event) => setApprovalConfirmed(event.target.checked)}
                      className="mt-1 h-4 w-4 accent-[#b8924a]"
                    />
                    <span>
                      J’ai relu le destinataire et le message, et j’autorise cet envoi précis.
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={shareEmail}
                      onChange={(event) => setShareEmail(event.target.checked)}
                      className="mt-1 h-4 w-4 accent-[#b8924a]"
                    />
                    <span>
                      J’accepte de rejoindre le dossier partagé. Les réponses sont centralisées par
                      ImmoJudis et mon adresse personnelle n’est pas communiquée au destinataire.
                    </span>
                  </label>
                  <div className="flex items-start gap-2 border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#166534]" />
                    L’email indique clairement qu’il est préparé par une IA. Aucune information sur
                    votre budget ou votre plafond d’enchère n’est transmise.
                  </div>
                </div>

                {activeMission.failureReason ? (
                  <p className="rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                    Dernier essai : {activeMission.failureReason}
                  </p>
                ) : null}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      actionMutation.mutate({
                        data: { action: "cancel", missionId: activeMission.id },
                      })
                    }
                  >
                    Annuler le brouillon
                  </Button>
                  <Button
                    type="button"
                    disabled={!canSend || busy}
                    onClick={() =>
                      actionMutation.mutate({
                        data: {
                          action: "approve_and_send",
                          missionId: activeMission.id,
                          approvalConfirmed: true,
                          shareRequesterEmail: true,
                          recipientEmail,
                          recipientName: recipientName || null,
                          subject,
                          bodyText,
                        },
                      })
                    }
                  >
                    {actionMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    Valider et envoyer
                  </Button>
                </div>
              </div>
            ) : null}

            {canRecordReply ? (
              <div className="grid gap-3 rounded-xl border border-border bg-white p-4">
                <div>
                  <h3 className="font-semibold text-foreground">Vous avez reçu une réponse ?</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Collez-la ici pour la rattacher au dossier. Son contenu reste considéré comme
                    non vérifié.
                  </p>
                </div>
                <textarea
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  rows={6}
                  maxLength={16000}
                  placeholder="Collez la réponse reçue…"
                  className={`${fieldClassName} resize-y`}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!replyText.trim() || busy}
                    onClick={() => replyMutation.mutate()}
                  >
                    {replyMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MailSearch className="h-4 w-4" />
                    )}
                    Enregistrer la réponse
                  </Button>
                </div>
              </div>
            ) : null}

            {sharedFacts.length ? (
              <div className="grid gap-3 rounded-xl border border-border bg-white p-4">
                <div>
                  <h3 className="font-semibold text-foreground">Informations reçues</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Les éléments sont partagés avec les utilisateurs de cette enquête. Ils ne
                    modifient l’annonce et ses estimations qu’après validation ImmoJudis.
                  </p>
                </div>
                <div className="grid gap-2">
                  {sharedFacts.map((fact) => (
                    <div
                      key={fact.id}
                      className="flex flex-col gap-1 rounded-lg border border-border/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="text-sm text-foreground">{fact.displayValue}</span>
                      <span className="text-xs font-semibold text-muted-foreground">
                        {fact.status === "accepted"
                          ? "Vérifié et intégré"
                          : fact.status === "rejected"
                            ? "Non retenu"
                            : fact.status === "conflict"
                              ? "Contradiction à vérifier"
                              : "À vérifier"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function AgentPreview() {
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-2">
        {["Pièces du dossier", "Photos", "Visites", "Occupation"].map((label) => (
          <span
            key={label}
            className="rounded-full border border-gold/20 bg-white px-2.5 py-1 text-xs text-muted-foreground"
          >
            {label}
          </span>
        ))}
      </div>
      <details className="group rounded-xl border border-border bg-white p-4">
        <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold text-foreground">
          <MailSearch className="h-5 w-5 text-gold-soft" />
          Voir les questions que l’agent préparerait
          <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">
            Ouvrir
          </span>
          <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">
            Fermer
          </span>
        </summary>
        <div className="mt-4 grid gap-2 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          <p>• Pouvez-vous transmettre le cahier des conditions de vente ?</p>
          <p>• Disposez-vous de photos complémentaires ou plus récentes ?</p>
          <p>• Quelles sont les prochaines dates et modalités de visite ?</p>
          <p>• Le bien est-il libre, occupé ou loué à ce jour ?</p>
        </div>
      </details>
      <div className="flex flex-col gap-3 rounded-xl border border-gold/20 bg-white/80 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#166534]" />
          <span>
            Chaque destinataire, objet et message reste modifiable. L’envoi exige deux validations
            explicites et révèle l’usage de l’IA.
          </span>
        </div>
        <Button asChild className="shrink-0">
          <Link to="/accompagnement">Découvrir Analyse</Link>
        </Button>
      </div>
    </div>
  );
}

function DraftStarter({
  recipientEmail,
  recipientName,
  onEmailChange,
  onNameChange,
  onCreate,
  busy,
}: {
  recipientEmail: string;
  recipientName: string;
  onEmailChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom de l’intermédiaire" htmlFor="agent-starter-name">
          <input
            id="agent-starter-name"
            value={recipientName}
            onChange={(event) => onNameChange(event.target.value)}
            maxLength={180}
            placeholder="Ex. Maître Dupont"
            className={fieldClassName}
          />
        </Field>
        <Field label="Email professionnel" htmlFor="agent-starter-email">
          <input
            id="agent-starter-email"
            type="email"
            value={recipientEmail}
            onChange={(event) => onEmailChange(event.target.value)}
            maxLength={320}
            placeholder="contact@cabinet.fr"
            required
            className={fieldClassName}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-white/75 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3 text-sm text-muted-foreground">
          <MailSearch className="mt-0.5 h-5 w-5 shrink-0 text-gold-soft" />
          <span>
            Vérifiez le destinataire proposé à partir de l’annonce. L’agent analysera les lacunes de
            cette annonce et préparera les questions utiles. Cette étape n’envoie aucun email.
          </span>
        </div>
        <Button
          type="button"
          disabled={busy || !recipientEmail.trim()}
          onClick={onCreate}
          className="shrink-0"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
          Préparer l’enquête
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="grid gap-1.5 text-xs font-semibold text-foreground">
      {label}
      {children}
    </label>
  );
}

const fieldClassName =
  "w-full rounded-md border border-border bg-white px-3 py-2 text-sm font-normal text-foreground outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/15";

function gapLabel(value: string): string {
  return (
    {
      documents: "Pièces du dossier",
      photos: "Photos",
      visit: "Visites",
      occupancy: "Occupation",
      surface: "Surface",
      diagnostics: "Diagnostics",
      composition: "Composition",
      sale_terms: "Modalités de vente",
    }[value] ?? value
  );
}

function showError(error: Error) {
  toast.error(error instanceof Error ? error.message : "Action impossible.");
}
