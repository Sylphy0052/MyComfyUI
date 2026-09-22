import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type {
  AgentDecision,
  AgentProposal,
  AgentProposalKind,
  AgentProvider,
  AgentProviderId,
  ApprovalLog,
  GenerationJob,
  Recipe,
} from "../api/client";
import { BackendNotice, noticeSuffix } from "./BackendNotice";

/**
 * 提案の種別。`image_prompt` だけが承認後に生成 Job の投入へつながる。
 * 他の種別は表示だけで、ai-media への書き込みと Recipe 登録は行わない。
 */
const KINDS: { value: AgentProposalKind; label: string; needsShot: boolean }[] = [
  { value: "image_prompt", label: "画像prompt案 (承認で投入可)", needsShot: true },
  { value: "shot_breakdown", label: "Shot構成案 (表示のみ)", needsShot: false },
  {
    value: "reference_candidates",
    label: "参照画像候補 (表示のみ)",
    needsShot: false,
  },
  { value: "recipe_draft", label: "Recipe案 (表示のみ)", needsShot: true },
];

const STATE_LABELS: Record<string, string> = {
  proposed: "提案",
  approved: "承認済み",
  rejected: "却下",
  applied: "適用済み",
  failed: "取得失敗",
};

/**
 * 選択中の提案の承認が期限切れかを判定する。
 *
 * 期限切れの承認では適用できない。承認し直せる状態をこの判定で切り替える。期限を
 * 解釈できない記録はサーバと同じく期限切れとして扱う。
 */
function isApprovalExpired(
  proposal: AgentProposal | null,
  logs: ApprovalLog[],
): boolean {
  if (proposal?.state !== "approved") return false;
  const latest = logs[0];
  if (!latest || latest.decision !== "approved" || !latest.expires_at) {
    return false;
  }
  const deadline = Date.parse(latest.expires_at);
  return Number.isNaN(deadline) || deadline <= Date.now();
}

type Props = {
  projectId: string | null;
  sceneId: string | null;
  shotId: string | null;
  recipes: Recipe[];
  onAppliedJob: (job: GenerationJob) => void;
};

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} (${error.code} / request_id=${error.requestId})`
      : `${error.message} (${error.code})`;
  }
  return String(error);
}

/**
 * エージェント提案と承認境界の画面。
 *
 * 提案の取得は副作用を持たないため、そのまま実行できる。生成 Job の投入は承認と適用を
 * 分けて操作させ、承認しただけでは何も実行しない。対象と投入内容は適用の前に表示する。
 */
export function AgentPanel({
  projectId,
  sceneId,
  shotId,
  recipes,
  onAppliedJob,
}: Props) {
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  // 空文字は「未選択」を表す。未選択なら送信時にProviderを指定せず、サーバの既定
  // Providerを使う。
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [kind, setKind] = useState<AgentProposalKind>("image_prompt");
  const [recipeId, setRecipeId] = useState<string>("");
  const [instruction, setInstruction] = useState("");
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ApprovalLog[]>([]);
  // サーバが期限切れと判断した提案。画面の時計がずれていても承認し直せるようにする。
  // 提案ごとに覚える。別の提案を判断したときに、他の提案の記憶を消さない。
  const [expiredProposalIds, setExpiredProposalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = useState(false);
  // 非同期処理の後で、操作した提案がまだ選ばれているかを見るために持つ。
  const selectedIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await api.listAgentProviders();
        if (active) setProviders(list);
      } catch (cause) {
        // Provider 一覧が取れなくても、履歴の確認と他機能は続けられる。
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (recipeId === "" && recipes.length > 0) setRecipeId(recipes[0].id);
  }, [recipes, recipeId]);

  const refreshProposals = useCallback(async () => {
    if (!sceneId) return [];
    return api.listAgentProposals({ sceneId, limit: 50 });
  }, [sceneId]);

  const reloadProposals = useCallback(async () => {
    setProposals(await refreshProposals());
  }, [refreshProposals]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = await refreshProposals();
        // Scene を切り替えた直後の応答で、古い Scene の提案を表示しない。
        if (active) setProposals(list);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshProposals]);

  const selected = useMemo(
    () => proposals.find((proposal) => proposal.id === selectedId) ?? null,
    [proposals, selectedId],
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!selectedId) {
        if (active) setLogs([]);
        return;
      }
      try {
        const list = await api.listApprovalLogs({ subjectId: selectedId });
        if (active) setLogs(list);
      } catch (cause) {
        if (active) setError(describe(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedId]);

  // 描画のたびに見直す。選択中に期限が切れた承認でも、次の描画で適用を止める。
  const approvalExpired =
    isApprovalExpired(selected, logs) ||
    (selected !== null && expiredProposalIds.has(selected.id));
  const selectedKind = KINDS.find((entry) => entry.value === kind);
  const needsRecipe = kind === "image_prompt";
  const disabled =
    busy ||
    !projectId ||
    !sceneId ||
    (selectedKind?.needsShot === true && !shotId) ||
    (needsRecipe && !recipeId);

  const request = async () => {
    if (!projectId || !sceneId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const proposal = await api.createAgentProposal({
        kind,
        provider_id: providerId || null,
        project_id: projectId,
        scene_id: sceneId,
        shot_id: selectedKind?.needsShot ? shotId : null,
        recipe_id: needsRecipe || kind === "recipe_draft" ? recipeId : null,
        instruction,
      });
      setSelectedId(proposal.id);
      setNotice("提案を取得した。生成Jobは投入していない。");
      await reloadProposals();
    } catch (cause) {
      setError(describe(cause));
      // 取得に失敗した提案も履歴へ残る。一覧を取り直して失敗記録を見せる。
      await reloadProposals().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: AgentDecision) => {
    if (!selected) return;
    const target = selected.id;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.decideAgentProposal(target, decision);
      setExpiredProposalIds((current) => {
        if (!current.has(target)) return current;
        const next = new Set(current);
        next.delete(target);
        return next;
      });
      const logList = await api.listApprovalLogs({ subjectId: target });
      await reloadProposals();
      // 操作中に別の提案へ切り替えられていたら、その提案の履歴を上書きしない。
      if (selectedIdRef.current === target) {
        setNotice(
          decision === "approved"
            ? "承認を記録した。適用するまで生成Jobは投入されない。"
            : "却下を記録した。",
        );
        setLogs(logList);
      }
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!selected) return;
    const target = selected.id;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await api.applyAgentProposal(target);
      if (selectedIdRef.current === target) {
        setNotice(`承認済みの提案を適用した。job_id=${job.id}`);
      }
      onAppliedJob(job);
      await reloadProposals();
    } catch (cause) {
      setError(describe(cause));
      if (cause instanceof ApiError && cause.code === "APPROVAL_EXPIRED") {
        // 画面の時計が遅れていると期限切れを判定できず、同じ失敗を繰り返す。
        // サーバの判断を受けて、承認し直せる状態へ切り替える。
        setExpiredProposalIds((current) => new Set(current).add(target));
      }
    } finally {
      setBusy(false);
    }
  };

  const operation = selected?.planned_operation ?? null;
  const recipeOfProposal = recipes.find(
    (recipe) => recipe.id === selected?.recipe_id,
  );

  return (
    <section className="panel">
      <h2>エージェント</h2>
      <p className="muted">
        提案の取得は生成やファイルに触らない。副作用のある操作は対象と内容を確認し、
        承認したうえで適用する。
      </p>

      <ul className="muted">
        {providers.map((provider) => (
          <li key={provider.id}>
            {provider.label} ({provider.id}):{" "}
            {provider.available ? "利用可能" : "利用不可"}
            <BackendNotice provider={provider} />
          </li>
        ))}
      </ul>

      <label>
        Provider
        <select
          value={providerId}
          onChange={(event) =>
            setProviderId(event.target.value as AgentProviderId | "")
          }
        >
          <option value="">設定の既定Providerを使う</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label} ({provider.id})
              {provider.available ? "" : " - 利用不可"}
              {noticeSuffix(provider)}
            </option>
          ))}
        </select>
      </label>

      <label>
        提案の種別
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as AgentProposalKind)
          }
        >
          {KINDS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>

      <label>
        Recipe
        <select
          value={recipeId}
          onChange={(event) => setRecipeId(event.target.value)}
        >
          {recipes.map((recipe) => (
            <option key={recipe.id} value={recipe.id}>
              {recipe.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        指示
        <textarea
          value={instruction}
          rows={3}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="例: 暗室の赤色光を主光源にする。"
        />
      </label>

      <button type="button" disabled={disabled} onClick={request}>
        提案を取得
      </button>

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted">{notice}</p>}

      <h3>提案履歴</h3>
      {proposals.length === 0 && <p className="muted">提案はまだない。</p>}
      <ul>
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <button
              type="button"
              onClick={() => setSelectedId(proposal.id)}
              aria-pressed={proposal.id === selectedId}
            >
              {STATE_LABELS[proposal.state] ?? proposal.state} / {proposal.kind}{" "}
              / {proposal.provider_id} / {proposal.created_at}
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div>
          <h3>提案の内容</h3>
          <p className="muted">
            {selected.kind} / {STATE_LABELS[selected.state] ?? selected.state}
            {selected.model ? ` / model=${selected.model}` : ""}
          </p>
          {selected.failure_code && (
            <p className="error">
              {selected.failure_code}: {selected.failure_message}
            </p>
          )}
          {selected.output && (
            <pre>{JSON.stringify(selected.output, null, 2)}</pre>
          )}

          <h3>入力コンテキスト</h3>
          <p className="muted">
            Providerへ渡した内容。APIキーと認証情報は含めない。
          </p>
          <pre>{JSON.stringify(selected.request_context, null, 2)}</pre>

          {operation ? (
            <div>
              <h3>承認が必要な操作</h3>
              <ul>
                <li>操作: {operation.type}</li>
                <li>扱い: {operation.effect}</li>
                <li>
                  対象: project={String(operation.target.project_id)} / scene=
                  {String(operation.target.scene_id)} / shot=
                  {String(operation.target.shot_id)}
                </li>
                <li>
                  Recipe:{" "}
                  {recipeOfProposal?.name ?? String(operation.target.recipe_id)}
                </li>
                <li>digest: {operation.digest}</li>
              </ul>
              <h4>投入する入力</h4>
              <pre>{JSON.stringify(operation.payload, null, 2)}</pre>
              {recipeOfProposal && (
                <>
                  <h4>Recipeの既定値</h4>
                  <pre>{JSON.stringify(recipeOfProposal.defaults, null, 2)}</pre>
                </>
              )}
            </div>
          ) : (
            <p className="muted">
              この提案は副作用のある操作を伴わない。承認と適用の対象にならない。
            </p>
          )}

          {approvalExpired && (
            <p className="muted">
              承認の有効期限が切れている。適用するには承認し直す。
            </p>
          )}
          <div>
            <button
              type="button"
              disabled={
                busy ||
                !operation ||
                (selected.state !== "proposed" && !approvalExpired)
              }
              onClick={() => decide("approved")}
            >
              承認する
            </button>
            <button
              type="button"
              disabled={
                busy || (selected.state !== "proposed" && !approvalExpired)
              }
              onClick={() => decide("rejected")}
            >
              却下する
            </button>
            <button
              type="button"
              disabled={busy || selected.state !== "approved" || approvalExpired}
              onClick={apply}
            >
              適用して生成Jobを投入
            </button>
          </div>
          {selected.applied_job_id && (
            <p className="muted">投入済みJob: {selected.applied_job_id}</p>
          )}

          <h3>承認履歴</h3>
          {logs.length === 0 && <p className="muted">判断の記録はまだない。</p>}
          <ul>
            {logs.map((log) => (
              <li key={log.id}>
                {log.decided_at} / {log.decision} / {log.actor_type}:
                {log.actor_id} / {String(log.requested_operation.type)}
                {log.expires_at ? ` / 期限=${log.expires_at}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
