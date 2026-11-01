// Muse console (UI v2 §1.2): one advisory card directly under the hero.
// It replaces the bottom Explain panel, the assessment tab and the
// investigate tab. One "Explain this result" button runs the fallback
// chain (/v1/explain, then /v1/rug, then /v1/assessment, whichever
// /health reports configured first); Ask posts one question to /v1/chat;
// Investigate runs the existing loop. Every output renders inside the
// polite live region and ends with the advisory footer, so the score
// never looks AI-touched. With nothing configured the console collapses
// to one line and renders no buttons at all, enabled or disabled.
import { useState, type JSX } from "react";
import { fetchChat, pickExplainSource } from "../lib/api.ts";
import type { ChatState, ExplainSource } from "../lib/api.ts";
import type { AiFeatureAvailability } from "../lib/capabilities.ts";
import type {
  AssessmentState,
  HealthState,
  InvestigationState,
  ProviderInfo,
  Signal,
} from "../types.ts";
import { AskMuse } from "./AskMuse.tsx";
import { AssessmentPanel } from "./AssessmentPanel.tsx";
import { ScanStatus } from "./ScanStatus.tsx";
import { ExplainPanel, ExplainSentences } from "./ExplainPanel.tsx";
import { InvestigationPanel } from "./InvestigationPanel.tsx";

type ConsoleRequest =
  | { readonly kind: "explain"; readonly source: ExplainSource }
  | { readonly kind: "chat" }
  | { readonly kind: "investigation" };

function consoleModelId(health: HealthState | null): string | null {
  if (health === null) {
    return null;
  }
  const features = [health.explain, health.rug, health.chat, health.investigation, health.assessment];
  for (const feature of features) {
    if (feature !== undefined && "modelId" in feature && typeof feature.modelId === "string") {
      return feature.modelId;
    }
  }
  return null;
}

function chatModelId(health: HealthState | null): string {
  const chat = health?.chat;
  if (chat !== undefined && "modelId" in chat && typeof chat.modelId === "string") {
    return chat.modelId;
  }
  return "the configured model";
}

export function MuseConsole({
  address,
  apiKey,
  health,
  availability,
  score,
  assessment,
  provider,
  onRequestAssessment,
  investigation,
  onRunInvestigation,
  signals,
  onSignalLink,
  question,
  onQuestionChange,
  onQuestionClear,
}: {
  readonly address: string;
  readonly apiKey: string;
  readonly health: HealthState | null;
  readonly availability: AiFeatureAvailability;
  readonly score: number;
  readonly assessment: AssessmentState;
  readonly provider: ProviderInfo;
  readonly onRequestAssessment: () => void;
  readonly investigation: InvestigationState;
  readonly onRunInvestigation: () => void;
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
  readonly question: string;
  readonly onQuestionChange: (text: string) => void;
  readonly onQuestionClear: () => void;
}): JSX.Element {
  const explainSource = pickExplainSource(health);
  const showExplain =
    explainSource === "explain"
      ? availability.explain === "available"
      : explainSource === "rug"
        ? availability.rug === "available"
        : explainSource === "assessment";
  const showInvestigate = availability.investigation === "available";
  const showChat = availability.chat === "available";
  const [request, setRequest] = useState<ConsoleRequest | null>(null);
  const [explainNonce, setExplainNonce] = useState(0);
  const [chat, setChat] = useState<ChatState | null>(null);
  const [chatPending, setChatPending] = useState(false);
  const modelId = consoleModelId(health);

  if (!showExplain && !showInvestigate && !showChat) {
    return (
      <section className="card muse-console" aria-label="Muse console" data-testid="muse-console">
        <p data-testid="muse-unavailable" style={{ margin: 0 }}>
          <span aria-hidden="true">✦ </span>Muse is not connected on this server. Everything above is computed
          without it.
        </p>
      </section>
    );
  }

  function onExplain(): void {
    if (explainSource === null) {
      return;
    }
    setExplainNonce((value) => value + 1);
    setRequest({ kind: "explain", source: explainSource });
    if (explainSource === "assessment") {
      onRequestAssessment();
    }
  }

  function onInvestigate(): void {
    setRequest({ kind: "investigation" });
    onRunInvestigation();
  }

  function onAsk(): void {
    const trimmed = question.trim();
    if (trimmed.length === 0 || chatPending) {
      return;
    }
    setRequest({ kind: "chat" });
    setChatPending(true);
    void fetchChat(address, apiKey, trimmed).then((next) => {
      setChatPending(false);
      setChat(next);
    });
  }

  return (
    <section className="card muse-console" aria-label="Muse console" data-testid="muse-console">
      <div className="muse-head">
        <h2 className="muse-title">
          <span aria-hidden="true">✦ </span>Muse · advisory
        </h2>
        {modelId === null ? null : (
          <span className="muse-console-model">{modelId}</span>
        )}
      </div>
      <p className="muted" style={{ margin: "0 0 8px" }}>
        Muse reads the evidence above. It never changes the score.
      </p>
      <div className="muse-actions">
        {showExplain ? (
          <button type="button" className="button" onClick={onExplain}>
            Explain this result
          </button>
        ) : null}
        {showInvestigate ? (
          <button type="button" className="button-ghost" onClick={onInvestigate}>
            Investigate
          </button>
        ) : null}
      </div>
      {showChat ? (
        <AskMuse
          question={question}
          onQuestionChange={onQuestionChange}
          onQuestionClear={onQuestionClear}
          onAsk={onAsk}
          pending={chatPending}
          modelLabel={chatModelId(health)}
        />
      ) : null}
      {request === null ? null : (
        <div className="muse-out" aria-live="polite" data-testid="muse-output">
          {request.kind === "explain" && request.source === "assessment" ? (
            <AssessmentPanel
              state={assessment}
              score={score}
              provider={provider}
              onRequest={onRequestAssessment}
            />
          ) : null}
          {request.kind === "explain" && request.source !== "assessment" ? (
            <ExplainPanel
              key={`${request.source}-${explainNonce}`}
              address={address}
              apiKey={apiKey}
              source={request.source}
              signals={signals}
              onSignalLink={onSignalLink}
            />
          ) : null}
          {request.kind === "chat" ? (
            <ChatOutput
              pending={chatPending}
              chat={chat}
              signals={signals}
              onSignalLink={onSignalLink}
              onRetry={onAsk}
            />
          ) : null}
          {request.kind === "investigation" ? (
            <InvestigationPanel
              state={investigation}
              score={score}
              availability={availability.investigation}
              signals={signals}
              onSignalLink={onSignalLink}
              onRequest={onInvestigate}
            />
          ) : null}
          <p className="quiet muse-advisory" data-testid="muse-advisory" style={{ margin: "12px 0 0" }}>
            Advisory. The score above did not change.
          </p>
        </div>
      )}
    </section>
  );
}

function ChatOutput({
  pending,
  chat,
  signals,
  onSignalLink,
  onRetry,
}: {
  readonly pending: boolean;
  readonly chat: ChatState | null;
  readonly signals: readonly Signal[];
  readonly onSignalLink: (key: string) => void;
  readonly onRetry: () => void;
}): JSX.Element {
  if (pending && chat === null) {
    return <ScanStatus text="Asking Muse…" />;
  }
  if (chat === null) {
    return <ScanStatus text="Asking Muse…" />;
  }
  if (chat.status === "not-configured") {
    return <p style={{ margin: 0 }}>Ask is not configured on this server.</p>;
  }
  if (chat.status === "ready") {
    return (
      <div>
        <p className="muse-result-label" style={{ margin: "0 0 8px" }}>
          Ask · {chat.modelId}
        </p>
        <ExplainSentences
          narrative={chat.answers}
          droppedClaims={chat.droppedClaims}
          signals={signals}
          onSignalLink={onSignalLink}
        />
      </div>
    );
  }
  if (chat.status === "fallback") {
    return <p style={{ margin: 0 }}>The deterministic explanation stands.</p>;
  }
  return (
    <div>
      <p role="alert" style={{ margin: "0 0 8px" }}>
        The answer failed to load; the page result above stands.
      </p>
      <button type="button" className="button-ghost" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
