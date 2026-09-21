import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Archive,
  BookOpen,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Code2,
  Database,
  FileCheck2,
  GitBranch,
  Github,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  UserCheck,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import type { Document, Integration, Repository, Run, User } from '../../../shared/types.ts';
import './styles.css';
type Me = { user: User | null; csrf: string; githubOAuth: boolean };
type RunBundle = {
  run: Run;
  events: { id: number; time: string; kind: string; message: string; phase: Run['phase'] }[];
  artifacts: { id: string; name: string; hash: string; createdAt: string }[];
};
type SetupState = {
  github: boolean;
  githubOAuth: boolean;
  githubLogin: string | null;
  repositories: number;
};
type GitHubRepository = {
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
};
let csrf = '';
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.method && init.method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || 'Request failed');
  }
  return response.json();
}
const seven = ['planning', 'requirements', 'design', 'coding', 'testing', 'deployment', 'maintenance'];
function shortRunTitle(run: Run) {
  const value = (run.contract?.summary || run.prompt).replace(/\s+/g, ' ').trim();
  return value.length > 96 ? `${value.slice(0, 93).trimEnd()}…` : value;
}
function runGuidance(run: Run) {
  if (run.status === 'needs_input')
    return {
      label: 'Your decision is needed',
      detail: run.question || 'Answer the open product question.',
      action: true,
    };
  if (run.status === 'needs_review')
    return {
      label: 'Run Codex native review',
      detail: 'Type /review in this Codex project and choose Review uncommitted changes.',
      action: true,
    };
  if (run.status === 'awaiting_approval')
    return {
      label: 'Review deployment',
      detail: 'All required evidence passed. Approve or reject the exact release.',
      action: true,
    };
  if (run.status === 'repairing')
    return {
      label: 'Codex is repairing a failed check',
      detail: run.blocker || 'A required gate must be fixed and rerun.',
      action: false,
    };
  if (run.status === 'completed' && run.step === 'validated')
    return {
      label: 'Validation completed',
      detail: 'The existing workspace passed without changes or publication.',
      action: false,
    };
  if (run.status === 'completed' || run.status === 'monitoring')
    return {
      label: 'Work completed',
      detail: 'Required evidence is recorded and the release is under maintenance.',
      action: false,
    };
  if (run.status === 'failed' || run.status === 'blocked')
    return { label: 'Run needs attention', detail: run.blocker || 'Review the failure before resuming.', action: true };
  if (run.status === 'cancelled')
    return { label: 'Run cancelled', detail: 'No further lifecycle actions will run.', action: false };
  if (run.step === 'publish')
    return {
      label: 'Preparing the verified change',
      detail: 'Codex is creating the feature branch, commit, and pull request.',
      action: false,
    };
  if (run.step === 'ci')
    return {
      label: 'GitHub checks are running',
      detail: 'The verified commit is waiting for every required remote check.',
      action: false,
    };
  const guidance: Record<string, [string, string]> = {
    planning: ['Codex is planning', 'Inspecting the repository and defining scope, dependencies, effort, and risks.'],
    requirements: ['Codex is defining acceptance', 'Turning the request into measurable requirements and evidence.'],
    design: ['Codex is designing the change', 'Recording architecture, compatibility, security, and test strategy.'],
    coding: ['Codex is working in your checkout', 'Implementing or repairing the change in this same conversation.'],
    testing: ['Quality gates are running', `Current check: ${run.step.replaceAll('-', ' ')}.`],
    deployment: ['Preparing delivery', 'Publishing the verified revision and following required GitHub checks.'],
    maintenance: ['Monitoring the release', 'Following health evidence and preserving rollback information.'],
  };
  const [label, detail] = guidance[run.phase];
  return { label, detail, action: false };
}
function Login({ me }: { me: Me }) {
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">
          <ShieldCheck />
        </div>
        <p className="eyebrow">AUTONOMOUS ENGINEERING</p>
        <h1>
          Evidence decides
          <br />
          when work is done.
        </h1>
        <p className="login-copy">
          One request enters. A governed SDLC leaves requirements, code, tests, review, deployment, and maintenance
          evidence behind.
        </p>
        {me.githubOAuth ? (
          <a className="button primary wide" href="/auth/github">
            <Github size={17} /> Continue with GitHub
          </a>
        ) : (
          <div className="notice error">
            <AlertTriangle /> GitHub sign-in is unavailable on this instance. Contact the application administrator.
          </div>
        )}
        <p className="fine-print">Sign in with your GitHub identity. Every approval and policy change is audited.</p>
      </section>
      <div className="login-grid" aria-hidden="true" />
    </main>
  );
}
function Badge({ status }: { status: string }) {
  const icon =
    status === 'monitoring' || status === 'completed' || status === 'pass' ? (
      <CheckCircle2 />
    ) : status === 'failed' || status === 'blocked' || status === 'fail' || status === 'error' ? (
      <XCircle />
    ) : status === 'awaiting_approval' || status === 'needs_input' || status === 'needs_review' ? (
      <AlertTriangle />
    ) : (
      <LoaderCircle className="spin" />
    );
  return (
    <span className={`badge ${status}`}>
      {icon}
      {status.replaceAll('_', ' ')}
    </span>
  );
}
function PhaseRail({ run }: { run: Run }) {
  const active = seven.indexOf(run.phase);
  return (
    <div className="phase-rail">
      {seven.map((phase, i) => (
        <React.Fragment key={phase}>
          <div className={`phase ${i < active ? 'done' : i === active ? 'active' : ''}`}>
            <span>{i < active ? <Check size={13} /> : i + 1}</span>
            <em>{phase}</em>
          </div>
          {i < 6 && <div className={`rail ${i < active ? 'done' : ''}`} />}
        </React.Fragment>
      ))}
    </div>
  );
}
function Shell({
  me,
  children,
  page,
  setPage,
  logout,
}: {
  me: Me;
  children: React.ReactNode;
  page: string;
  setPage: (p: string) => void;
  logout: () => void;
}) {
  const nav = [
    { id: 'setup', label: 'Setup', icon: Wrench },
    { id: 'runs', label: 'Runs', icon: LayoutDashboard },
    { id: 'repositories', label: 'Repositories', icon: GitBranch },
    { id: 'knowledge', label: 'Company knowledge', icon: BookOpen },
    { id: 'system', label: 'System', icon: Activity },
  ];
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span>
            <ShieldCheck />
          </span>
          <div>
            <strong>SDLC</strong>
            <small>CONTROL PLANE</small>
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <button key={n.id} className={page === n.id ? 'selected' : ''} onClick={() => setPage(n.id)}>
              <n.icon />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="aside-foot">
          <div className="user-avatar">{me.user?.login.slice(0, 2).toUpperCase()}</div>
          <div>
            <strong>{me.user?.login}</strong>
            <small>{me.user?.role}</small>
          </div>
          <button className="icon-button" onClick={logout} title="Sign out">
            <LogOut />
          </button>
        </div>
      </aside>
      <section className="main-area">{children}</section>
    </div>
  );
}
function RunsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [error, setError] = useState('');
  const load = () =>
    Promise.all([api<Run[]>('/api/runs'), api<Repository[]>('/api/repositories')])
      .then(([r, p]) => {
        setRuns(r);
        setRepos(p);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const active = runs.filter((r) =>
    ['running', 'repairing', 'needs_input', 'needs_review', 'awaiting_approval'].includes(r.status),
  );
  const attention = runs.filter((r) => ['failed', 'blocked'].includes(r.status));
  const decisions = runs.filter((r) => ['needs_input', 'needs_review', 'awaiting_approval'].includes(r.status));
  const successful = runs.filter((r) => ['completed', 'monitoring'].includes(r.status));
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">ENGINEERING OPERATIONS</p>
          <h1>Work in progress</h1>
          <p>See what Codex is doing, what passed, and when you need to act.</p>
        </div>
        <span className="badge monitoring">Native Codex connected</span>
      </header>
      <div className="metric-grid">
        <Metric label="In progress" value={active.length} detail="Codex is working" icon={Activity} />
        <Metric
          label="Waiting for you"
          value={decisions.length}
          detail="Questions, review, or approval"
          icon={UserCheck}
        />
        <Metric label="Successful" value={successful.length} detail="Completed or monitored" icon={CheckCircle2} />
        <Metric label="Needs attention" value={attention.length} detail="Failed or blocked" icon={AlertTriangle} />
      </div>
      {error && (
        <div className="notice error">
          <AlertTriangle />
          {error}
        </div>
      )}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Run ledger</h2>
            <p>Current and historical work</p>
          </div>
          <button className="icon-button" onClick={load}>
            <RefreshCw />
          </button>
        </div>
        {!runs.length ? (
          <Empty
            title="No runs yet"
            text={
              repos.length
                ? 'Open this repository in the Codex app or CLI and ask for a feature or bug fix.'
                : 'Connect GitHub and configure a repository, then work normally in Codex.'
            }
          />
        ) : (
          <div className="run-list">
            {runs.map((run) => (
              <button className="run-row" key={run.id} onClick={() => onOpen(run.id)}>
                <div className="run-symbol">
                  <Code2 />
                </div>
                <div className="run-name">
                  <strong>{shortRunTitle(run)}</strong>
                  <span>
                    {run.policy.owner}/{run.policy.repo} · {run.mode === 'validation' ? 'validation' : 'delivery'}
                  </span>
                  <em>{runGuidance(run).label}</em>
                </div>
                <div className="run-phase">
                  <small>PHASE {seven.indexOf(run.phase) + 1}/7</small>
                  <strong>{run.phase}</strong>
                </div>
                <Badge status={run.status} />
                <ChevronRight />
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
function Metric({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: number;
  detail: string;
  icon: React.ComponentType<{ size?: number }>;
}) {
  return (
    <div className="metric">
      <div className="metric-icon">
        <Icon size={20} />
      </div>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function DetailList({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="detail-list">
      <h4>{title}</h4>
      <ul>
        {items.map((item, index) => (
          <li key={`${title}-${index}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function lifecyclePhaseState(run: Run, phase: Run['phase']) {
  const phaseIndex = seven.indexOf(phase);
  const currentIndex = seven.indexOf(run.phase);
  if (phaseIndex < currentIndex) return { className: 'complete', label: 'Complete' };
  if (phaseIndex > currentIndex) return { className: 'upcoming', label: 'Pending' };
  if (['completed', 'monitoring'].includes(run.status)) return { className: 'complete', label: 'Complete' };
  if (['blocked', 'failed', 'cancelled'].includes(run.status))
    return { className: 'attention', label: 'Needs attention' };
  return { className: 'current', label: 'Current phase' };
}

function PhaseSection({
  number,
  phase,
  title,
  description,
  icon: Icon,
  run,
  children,
}: {
  number: number;
  phase: Run['phase'];
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
  run: Run;
  children: React.ReactNode;
}) {
  const state = lifecyclePhaseState(run, phase);
  return (
    <section id={`phase-${phase}`} className={`panel phase-section run-section-anchor ${state.className}`}>
      <header className="phase-section-head">
        <span className="phase-number">{number}</span>
        <div>
          <p>SDLC PHASE {number} OF 7</p>
          <h2>{title}</h2>
          <span>{description}</span>
        </div>
        <Icon size={18} />
        <strong className="phase-state">{state.label}</strong>
      </header>
      <div className="phase-section-body">{children}</div>
    </section>
  );
}

function RunDetail({ id, back }: { id: string; back: () => void }) {
  const [bundle, setBundle] = useState<RunBundle | null>(null);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [approve, setApprove] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [showAllArtifacts, setShowAllArtifacts] = useState(false);
  const load = () =>
    api<RunBundle>(`/api/runs/${id}`)
      .then(setBundle)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [id]);
  async function action(path: string, body?: unknown) {
    try {
      await api(`/api/runs/${id}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
      setApprove(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!bundle)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
        Loading run evidence…
      </div>
    );
  const run = bundle.run;
  const guidance = runGuidance(run);
  const latestEvent = bundle.events.at(-1);
  const phaseNumber = seven.indexOf(run.phase) + 1;
  const events = bundle.events.slice().reverse();
  const visibleEvents = showAllEvents ? events : events.slice(0, 8);
  const visibleArtifacts = showAllArtifacts ? bundle.artifacts : bundle.artifacts.slice(0, 8);
  const codingEvents = events.filter((event) => event.phase === 'coding').slice(0, 4);
  const gateTotal = run.gates.length || run.policy.checks.length;
  const gatePassed = run.gates.filter((gate) => ['pass', 'waived'].includes(gate.status)).length;
  const gateFailed = run.gates.filter((gate) => ['fail', 'error'].includes(gate.status)).length;
  const gatePending = Math.max(0, gateTotal - gatePassed - gateFailed);
  const reviewByCriterion = new Map(run.review?.criteria.map((criterion) => [criterion.id, criterion]) || []);
  const deploymentAdvanced = seven.indexOf(run.phase) > seven.indexOf('deployment');
  const remoteCiPassed =
    !!run.prUrl &&
    (deploymentAdvanced || ['approval', 'release', 'smoke', 'monitoring', 'completed'].includes(run.step));
  return (
    <>
      <header className="detail-head">
        <button className="back" onClick={back}>
          ← Runs
        </button>
        <div className="detail-title">
          <div>
            <p className="eyebrow">RUN {run.id.slice(0, 8).toUpperCase()}</p>
            <h1>{shortRunTitle(run)}</h1>
            <p>
              {run.policy.owner}/{run.policy.repo} · candidate{' '}
              {(run.candidateSha || run.candidateDigest)?.slice(0, 9) || 'pending'}
            </p>
            <details className="request-details">
              <summary>View original request</summary>
              <p>{run.prompt}</p>
            </details>
          </div>
          <div className="detail-actions">
            <Badge status={run.status} />
            {run.prUrl && (
              <a className="button quiet" href={run.prUrl} target="_blank" rel="noreferrer">
                <Github />
                Pull request
              </a>
            )}
            <a className="button quiet" href={`/api/runs/${id}/report`}>
              <FileCheck2 />
              Evidence report
            </a>
          </div>
        </div>
      </header>
      {error && (
        <div className="notice error">
          <AlertTriangle />
          {error}
        </div>
      )}
      {run.blocker && (
        <div className="notice warning">
          <AlertTriangle />
          <div>
            <strong>Run stopped</strong>
            <p>{run.blocker}</p>
          </div>
          {['blocked', 'failed'].includes(run.status) && (
            <button className="button quiet" onClick={() => action('resume')}>
              Resume after correction
            </button>
          )}
        </div>
      )}
      {run.status === 'needs_input' && (
        <div className="decision">
          <div>
            <strong>Decision required</strong>
            <p>{run.question}</p>
          </div>
          <div className="answer">
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Record the stakeholder decision"
            />
            <button className="button primary" disabled={!answer} onClick={() => action('answer', { answer })}>
              Submit
            </button>
          </div>
        </div>
      )}
      {run.status === 'awaiting_approval' && (
        <div className="decision deployment">
          <Rocket />
          <div>
            <strong>Deployment approval required</strong>
            <p>
              Release <code>{run.candidateSha}</code> to <b>{run.policy.deployment.environment}</b> through{' '}
              <code>{run.policy.deployment.workflow}</code>. Required local and remote gates passed.
            </p>
          </div>
          <button className="button primary" onClick={() => setApprove(true)}>
            Review deployment
          </button>
        </div>
      )}
      {run.status === 'needs_review' && (
        <div className="decision native-review">
          <Search />
          <div>
            <strong>Codex native review required</strong>
            <p>
              In this project, type <code>/review</code> and choose <b>Review uncommitted changes</b>. The dedicated
              reviewer reports findings without modifying the working tree; return here afterward to continue the run.
            </p>
          </div>
        </div>
      )}
      <section className={`run-focus ${guidance.action ? 'action' : ''}`}>
        <div className="focus-icon">{guidance.action ? <UserCheck /> : <Activity />}</div>
        <div className="focus-copy">
          <span className="eyebrow">{guidance.action ? 'ACTION REQUIRED' : 'HAPPENING NOW'}</span>
          <h2>{guidance.label}</h2>
          <p>{guidance.detail}</p>
          {latestEvent && <small>Latest update: {latestEvent.message}</small>}
        </div>
        <div className="focus-phase">
          <strong>{phaseNumber}/7</strong>
          <span>{run.phase}</span>
        </div>
        <PhaseRail run={run} />
      </section>
      <section className="run-facts" aria-label="Run summary">
        <div>
          <span>Mode</span>
          <strong>{run.mode || 'delivery'}</strong>
        </div>
        <div>
          <span>Repository</span>
          <strong>
            {run.policy.owner}/{run.policy.repo}
          </strong>
        </div>
        <div>
          <span>Policy</span>
          <strong>Version {run.policy.version}</strong>
        </div>
        <div>
          <span>Revision</span>
          <strong>{(run.candidateSha || run.candidateDigest || run.workspace.headSha).slice(0, 9)}</strong>
        </div>
      </section>
      <nav className="run-detail-nav" aria-label="Seven SDLC phases">
        {seven.map((phase, index) => (
          <a href={`#phase-${phase}`} key={phase}>
            <span>{index + 1}</span>
            {phase[0].toUpperCase() + phase.slice(1)}
          </a>
        ))}
      </nav>
      <div className="lifecycle-sections">
        <PhaseSection
          number={1}
          phase="planning"
          title="Planning"
          description="Define the scope, execution approach, resources, schedule, dependencies, and delivery risks."
          icon={Archive}
          run={run}
        >
          {run.plan ? (
            <div className="phase-grid">
              <article className="phase-card">
                <div className="subsection-head">
                  <span>Scope and execution plan</span>
                  <CheckCircle2 />
                </div>
                <p className="phase-lead">{run.plan.scope}</p>
                <ol className="plan-steps">
                  {run.plan.steps.map((step, index) => (
                    <li key={`${index}-${step}`}>
                      <span>{index + 1}</span>
                      <p>{step}</p>
                    </li>
                  ))}
                </ol>
                <div className="phase-tags">
                  <span>
                    {run.plan.source === 'codex-plan-mode' ? 'Native Codex Plan mode' : 'Legacy planning record'}
                  </span>
                  <span>{run.plan.estimatedEffort}</span>
                  <span>{run.plan.costEstimate}</span>
                </div>
              </article>
              <article className="phase-card phase-context">
                <div className="subsection-head">
                  <span>Schedule and planning context</span>
                </div>
                <div className="detail-list-grid">
                  <DetailList title="Schedule" items={run.plan.schedule} />
                  <DetailList title="Dependencies" items={run.plan.dependencies} />
                  <DetailList title="Planning risks" items={run.plan.risks} />
                </div>
              </article>
            </div>
          ) : (
            <Empty
              title="Planning pending"
              text="Scope, schedule, dependencies, and execution steps will appear here."
              compact
            />
          )}
        </PhaseSection>

        <PhaseSection
          number={2}
          phase="requirements"
          title="Requirements"
          description="Turn the request into measurable behavior, boundaries, assumptions, and acceptance evidence."
          icon={BookOpen}
          run={run}
        >
          {run.contract ? (
            <>
              <p className="phase-lead">{run.contract.summary}</p>
              <div className="phase-grid requirements-grid">
                <article className="phase-card">
                  <div className="subsection-head">
                    <span>Acceptance criteria</span>
                    <strong>{run.contract.criteria.length}</strong>
                  </div>
                  <div className="criteria-list">
                    {run.contract.criteria.map((criterion) => {
                      const verdict = reviewByCriterion.get(criterion.id);
                      return (
                        <div className={verdict?.satisfied ? 'satisfied' : ''} key={criterion.id}>
                          <span>{verdict?.satisfied ? <Check /> : <Circle />}</span>
                          <div>
                            <strong>{criterion.id}</strong>
                            <p>{criterion.description}</p>
                            {verdict?.evidence && <small>{verdict.evidence}</small>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </article>
                <article className="phase-card phase-context">
                  <div className="subsection-head">
                    <span>Scope boundaries and assumptions</span>
                  </div>
                  <div className="detail-list-grid">
                    <DetailList title="Assumptions" items={run.contract.assumptions} />
                    <DetailList title="Non-goals" items={run.contract.nonGoals} />
                    <DetailList title="Requirement risks" items={run.contract.risks} />
                  </div>
                  <div className="phase-callout">
                    <span>Clarification</span>
                    <p>{run.question || run.answer || 'No stakeholder clarification is open.'}</p>
                  </div>
                </article>
              </div>
            </>
          ) : (
            <Empty
              title="Requirements pending"
              text="Acceptance criteria and scope boundaries will appear here."
              compact
            />
          )}
        </PhaseSection>

        <PhaseSection
          number={3}
          phase="design"
          title="Design"
          description="Describe the architecture, interfaces, data, user experience, security, and compatibility."
          icon={Boxes}
          run={run}
        >
          {run.design ? (
            <>
              <p className="phase-lead">{run.design.architecture}</p>
              <div className="phase-card">
                <div className="detail-list-grid design-grid">
                  <DetailList title="API contracts" items={run.design.apiContracts} />
                  <DetailList title="Data changes" items={run.design.dataChanges} />
                  <DetailList title="UI behavior" items={run.design.uiBehavior} />
                  <DetailList title="Security" items={run.design.security} />
                </div>
                <div className="phase-callout">
                  <span>Compatibility</span>
                  <p>{run.design.compatibility}</p>
                </div>
              </div>
            </>
          ) : (
            <Empty title="Design pending" text="Architecture and implementation decisions will appear here." compact />
          )}
        </PhaseSection>

        <PhaseSection
          number={4}
          phase="coding"
          title="Coding"
          description="Implement the approved design in the developer's existing checkout and repair discovered defects."
          icon={Code2}
          run={run}
        >
          <div className="implementation-facts">
            <div>
              <span>Current step</span>
              <strong>{run.step.replaceAll('-', ' ')}</strong>
            </div>
            <div>
              <span>Workspace branch</span>
              <strong>{run.workspace.branch}</strong>
            </div>
            <div>
              <span>Starting revision</span>
              <strong>{run.workspace.headSha.slice(0, 9)}</strong>
            </div>
            <div>
              <span>Candidate tree</span>
              <strong>{run.candidateDigest?.slice(0, 9) || 'Not verified'}</strong>
            </div>
            <div>
              <span>Candidate commit</span>
              <strong>{run.candidateSha?.slice(0, 9) || 'Not published'}</strong>
            </div>
            <div>
              <span>Repair attempts</span>
              <strong>{run.attempt}</strong>
            </div>
          </div>
          <article className="phase-card coding-activity">
            <div className="subsection-head">
              <span>Implementation activity</span>
              <small>{codingEvents.length ? `${codingEvents.length} recent updates` : 'No coding updates yet'}</small>
            </div>
            {codingEvents.length ? (
              <div className="compact-events">
                {codingEvents.map((event) => (
                  <div key={event.id}>
                    <time>{new Date(event.time).toLocaleTimeString()}</time>
                    <p>{event.message}</p>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                title="Implementation pending"
                text="Coding updates will appear after the design checkpoint."
                compact
              />
            )}
          </article>
        </PhaseSection>

        <PhaseSection
          number={5}
          phase="testing"
          title="Testing"
          description="Run every configured quality gate and review the verified candidate against acceptance criteria."
          icon={ShieldCheck}
          run={run}
        >
          {run.design && (
            <div className="phase-callout test-strategy">
              <span>Test strategy</span>
              <p>{run.design.testStrategy}</p>
            </div>
          )}
          <div className="verification-summary" aria-label="Verification summary">
            <div>
              <span>Total gates</span>
              <strong>{gateTotal}</strong>
            </div>
            <div className="passed">
              <span>Passed</span>
              <strong>{gatePassed}</strong>
            </div>
            <div className={gateFailed ? 'failed' : ''}>
              <span>Failed</span>
              <strong>{gateFailed}</strong>
            </div>
            <div>
              <span>Pending</span>
              <strong>{gatePending}</strong>
            </div>
          </div>
          <div className="phase-grid testing-grid">
            <div className="phase-card">
              <div className="subsection-head">
                <span>Quality gates</span>
                <small>{run.candidateDigest ? `Tree ${run.candidateDigest.slice(0, 9)}` : 'Candidate pending'}</small>
              </div>
              <div className="gate-list">
                {!run.gates.length ? (
                  <Empty title="Verification pending" text="Configured gates appear after implementation." compact />
                ) : (
                  run.gates.map((gate) => (
                    <div className="gate" key={gate.id}>
                      <span className={gate.status}>
                        <GateIcon status={gate.status} />
                      </span>
                      <div>
                        <strong>{gate.label}</strong>
                        <small>
                          {gate.cached ? 'Reused' : gate.tests === null ? 'Command' : `${gate.tests} tests`} ·{' '}
                          {gate.durationMs}ms
                        </small>
                        {gate.findings.map((finding) => (
                          <em key={finding}>{finding}</em>
                        ))}
                      </div>
                      {gate.artifactId && (
                        <a className="gate-evidence" href={`/api/artifacts/${gate.artifactId}`}>
                          Evidence
                        </a>
                      )}
                      <Badge status={gate.status} />
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="phase-card">
              <div className="subsection-head">
                <span>Native Codex review</span>
                <Search />
              </div>
              {run.review ? (
                <>
                  <div className="phase-tags review-provenance">
                    <span>
                      {run.review.source === 'codex-native-review' ? 'Codex /review' : 'Legacy review record'}
                    </span>
                    <span>Scope: {run.review.scope || 'legacy'}</span>
                  </div>
                  <p className="review-summary">{run.review.summary}</p>
                  {!run.review.findings.length && (
                    <div className="review-clear">
                      <CheckCircle2 /> No review findings
                    </div>
                  )}
                  {run.review.findings.map((finding) => (
                    <div className="finding" key={finding.id}>
                      <span className={finding.severity}>{finding.severity}</span>
                      <div>
                        <strong>
                          {finding.file}:{finding.line}
                        </strong>
                        <p>{finding.description}</p>
                        <small>{finding.correction}</small>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <Empty
                  title={
                    run.status === 'needs_review'
                      ? 'Native review required'
                      : run.reviewDecision && !run.reviewDecision.required
                        ? 'Review not required'
                        : 'Review pending'
                  }
                  text={
                    run.status === 'needs_review'
                      ? `Type /review in Codex and choose Review uncommitted changes. ${run.reviewDecision?.reasons.join(' ') || ''}`
                      : run.reviewDecision && !run.reviewDecision.required
                        ? 'Repository policy classified this verified change as low risk.'
                        : 'Review policy is evaluated after automated gates pass.'
                  }
                  compact
                />
              )}
            </div>
          </div>
        </PhaseSection>

        <PhaseSection
          number={6}
          phase="deployment"
          title="Deployment"
          description="Publish the verified revision, pass remote CI, obtain approval when required, and release safely."
          icon={Rocket}
          run={run}
        >
          <div className="delivery-grid">
            <article className="delivery-step">
              <span>1 · Publication</span>
              <strong>{run.prUrl ? 'Pull request available' : 'Pending verified code'}</strong>
              <p>
                {run.prUrl
                  ? `Candidate ${run.candidateSha?.slice(0, 9)} is published for review.`
                  : 'Begins after testing and native Codex review pass.'}
              </p>
              {run.prUrl && (
                <a className="text-link" href={run.prUrl} target="_blank" rel="noreferrer">
                  <Github /> Open pull request
                </a>
              )}
            </article>
            <article className="delivery-step">
              <span>2 · Remote CI</span>
              <strong>
                {run.step === 'remote-ci' ? 'Checks running' : remoteCiPassed ? 'Checks passed' : 'Pending'}
              </strong>
              <p>Required repository checks must pass for the exact published commit.</p>
            </article>
            <article className="delivery-step">
              <span>3 · Approval</span>
              <strong>
                {!run.policy.deployment.enabled
                  ? 'Not required by policy'
                  : run.approval?.approvedBy
                    ? `Approved by ${run.approval.approvedBy}`
                    : run.status === 'awaiting_approval'
                      ? 'Waiting for user'
                      : 'Pending'}
              </strong>
              <p>
                {run.policy.deployment.enabled
                  ? `Only the dashboard can authorize ${run.policy.deployment.environment}.`
                  : 'This repository completes after its pull request and required CI checks pass.'}
              </p>
            </article>
            <article className="delivery-step">
              <span>4 · Release</span>
              <strong>
                {run.deployment?.releasedAt ? 'Released' : run.policy.deployment.enabled ? 'Pending' : 'Not configured'}
              </strong>
              <p>
                {run.deployment?.releasedAt
                  ? `${run.policy.deployment.environment} released at ${new Date(run.deployment.releasedAt).toLocaleString()}.`
                  : run.policy.deployment.enabled
                    ? `Workflow ${run.policy.deployment.workflow} runs after approval.`
                    : 'No automated environment release is configured for this policy.'}
              </p>
            </article>
          </div>
          <div className="phase-actions">
            <a className="button quiet" href={`/api/runs/${id}/report`}>
              <FileCheck2 /> Evidence report
            </a>
            {run.status === 'awaiting_approval' && (
              <button className="button primary" onClick={() => setApprove(true)}>
                <Rocket /> Review deployment
              </button>
            )}
          </div>
        </PhaseSection>

        <PhaseSection
          number={7}
          phase="maintenance"
          title="Maintenance"
          description="Keep the durable delivery record, monitor released software, and preserve evidence for future support."
          icon={Wrench}
          run={run}
        >
          <div className="maintenance-summary">
            <Database />
            <div>
              <strong>
                {run.status === 'monitoring'
                  ? 'Health monitoring is active'
                  : run.status === 'completed'
                    ? 'Lifecycle evidence is complete'
                    : 'Maintenance begins after delivery'}
              </strong>
              <p>
                {run.deployment?.healthy
                  ? 'The released environment is healthy.'
                  : 'Activity and evidence remain available here throughout the run.'}
              </p>
            </div>
          </div>
          <div className="history-grid">
            <div className="phase-card history-pane">
              <div className="subsection-head">
                <span>Lifecycle activity</span>
                <div>
                  <small>{bundle.events.length} events</small>
                  {bundle.events.length > 8 && (
                    <button className="text-button" onClick={() => setShowAllEvents(!showAllEvents)}>
                      {showAllEvents ? 'Show recent' : 'Show all activity'}
                    </button>
                  )}
                </div>
              </div>
              {visibleEvents.length ? (
                <div className="timeline">
                  {visibleEvents.map((event) => (
                    <div key={event.id}>
                      <span>
                        <Circle />
                      </span>
                      <time>{new Date(event.time).toLocaleTimeString()}</time>
                      <div>
                        <b>{event.kind.replaceAll('-', ' ')}</b>
                        <p>{event.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty title="No activity yet" text="Lifecycle events will appear here." compact />
              )}
            </div>
            <div className="phase-card history-pane">
              <div className="subsection-head">
                <span>Evidence ledger</span>
                <div>
                  <small>{bundle.artifacts.length} files</small>
                  {bundle.artifacts.length > 8 && (
                    <button className="text-button" onClick={() => setShowAllArtifacts(!showAllArtifacts)}>
                      {showAllArtifacts ? 'Show recent' : 'Show all files'}
                    </button>
                  )}
                </div>
              </div>
              {visibleArtifacts.length ? (
                <div className="artifact-list">
                  {visibleArtifacts.map((artifact) => (
                    <a href={`/api/artifacts/${artifact.id}`} key={artifact.id}>
                      <FileCheck2 />
                      <span>
                        <strong>{artifact.name}</strong>
                        <small>sha256 {artifact.hash.slice(0, 12)}…</small>
                      </span>
                    </a>
                  ))}
                </div>
              ) : (
                <Empty title="No evidence files yet" text="Plans, reports, and logs will appear here." compact />
              )}
            </div>
          </div>
        </PhaseSection>
      </div>
      {!['monitoring', 'completed', 'failed', 'cancelled'].includes(run.status) && (
        <button className="danger-link" onClick={() => action('cancel')}>
          <X />
          Cancel run
        </button>
      )}
      {approve && (
        <Modal title="Authorize this deployment" close={() => setApprove(false)}>
          <div className="approval-summary">
            <p>This records an audited decision for one immutable release.</p>
            <dl>
              <dt>Environment</dt>
              <dd>{run.policy.deployment.environment}</dd>
              <dt>Revision</dt>
              <dd>
                <code>{run.candidateSha}</code>
              </dd>
              <dt>Workflow</dt>
              <dd>{run.policy.deployment.workflow}</dd>
              <dt>Approval digest</dt>
              <dd>
                <code>{run.approval?.digest}</code>
              </dd>
            </dl>
            <div className="notice warning">
              <AlertTriangle />
              The workflow can change live systems. Rollback runs automatically if the health check fails.
            </div>
          </div>
          <div className="modal-actions">
            <button
              className="button quiet"
              onClick={() => action('approval', { approved: false, digest: run.approval?.digest })}
            >
              Reject
            </button>
            <button
              className="button primary"
              onClick={() => action('approval', { approved: true, digest: run.approval?.digest })}
            >
              <Rocket />
              Approve deployment
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function GateIcon({ status }: { status: string }) {
  return status === 'pass' || status === 'waived' ? (
    <Check />
  ) : status === 'fail' || status === 'error' ? (
    <X />
  ) : (
    <LoaderCircle className="spin" />
  );
}
function RepositoriesPage() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Repository['checks']>>({});
  const [available, setAvailable] = useState<GitHubRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const fresh = {
    name: '',
    owner: '',
    repo: '',
    branch: 'main',
    stack: 'typescript' as 'typescript' | 'python' | 'custom',
    checksJson: '',
    standards: '',
    requiredCiChecks: 'ci',
    ciWaiver: '',
    reviewMode: 'risk-based' as 'always' | 'risk-based',
    minimumRisk: 'medium' as 'low' | 'medium' | 'high',
    sensitivePaths:
      '.github/workflows/**, **/migrations/**, **/auth/**, **/security/**, **/billing/**, **/payments/**, **/infra/**',
    maxChangedFiles: 8,
    requireChangedTests: true,
    sourcePaths: 'src/**, app/**, apps/**, lib/**, packages/**/src/**',
    testPaths: 'test/**, tests/**, **/__tests__/**, **/*.test.*, **/*.spec.*',
    deploymentEnabled: false,
    deploymentTarget: '',
    healthUrl: '',
    workflow: 'deploy.yml',
    rollbackWorkflow: 'rollback.yml',
    environment: 'staging',
  };
  const [form, setForm] = useState(fresh);
  const selectedRepository = repos.find(
    (repository) =>
      repository.owner.toLowerCase() === form.owner.toLowerCase() &&
      repository.repo.toLowerCase() === form.repo.toLowerCase(),
  );
  const reviewingDetectedSetup = selectedRepository?.setup?.status === 'needs_confirmation';
  const detectedSetup =
    selectedRepository?.setup?.source === 'detected' &&
    !['ready', 'confirmed'].includes(selectedRepository.setup.status)
      ? selectedRepository.setup
      : undefined;
  const selectedFullName = form.owner && form.repo ? `${form.owner}/${form.repo}` : '';
  const selectedIsAvailable = available.some(
    (repository) => repository.fullName.toLowerCase() === selectedFullName.toLowerCase(),
  );
  const load = () =>
    Promise.all([
      api<Repository[]>('/api/repositories'),
      api<Record<string, Repository['checks']>>('/api/profiles'),
      api<GitHubRepository[]>('/api/github/repositories').catch(() => []),
    ])
      .then(([r, p, g]) => {
        setRepos(r);
        setProfiles(p);
        setAvailable(g);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  function choose(fullName: string) {
    const selected = available.find((repo) => repo.fullName === fullName);
    if (!selected) return;
    const [owner, repo] = selected.fullName.split('/');
    const stack = selected.language?.toLowerCase() === 'python' ? 'python' : 'typescript';
    setForm({ ...form, name: selected.name, owner, repo, branch: selected.defaultBranch, stack });
  }
  function edit(repository: Repository) {
    setForm({
      name: repository.name,
      owner: repository.owner,
      repo: repository.repo,
      branch: repository.branch,
      stack: repository.stack,
      checksJson: JSON.stringify(repository.checks, null, 2),
      standards: repository.standards,
      requiredCiChecks: repository.requiredCiChecks.join(', '),
      ciWaiver: repository.ciWaiver,
      reviewMode: repository.review?.mode || 'risk-based',
      minimumRisk: repository.review?.minimumRisk || 'medium',
      sensitivePaths: (repository.review?.sensitivePaths || []).join(', '),
      maxChangedFiles: repository.review?.maxChangedFiles || 8,
      requireChangedTests: repository.testEvidence?.requiredForSourceChanges ?? true,
      sourcePaths: (repository.testEvidence?.sourcePaths || []).join(', '),
      testPaths: (repository.testEvidence?.testPaths || []).join(', '),
      deploymentEnabled: repository.deployment.enabled,
      deploymentTarget: repository.deployment.target || '',
      healthUrl: repository.deployment.healthUrl,
      workflow: repository.deployment.workflow,
      rollbackWorkflow: repository.deployment.rollbackWorkflow,
      environment: repository.deployment.environment,
    });
    setOpen(true);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/repositories', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          owner: form.owner,
          repo: form.repo,
          branch: form.branch,
          stack: form.stack,
          standards: form.standards,
          checks: form.checksJson.trim() ? JSON.parse(form.checksJson) : profiles[form.stack],
          requiredCiChecks: form.requiredCiChecks
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          ciWaiver: form.ciWaiver,
          review: {
            mode: form.reviewMode,
            minimumRisk: form.minimumRisk,
            sensitivePaths: form.sensitivePaths
              .split(',')
              .map((path) => path.trim())
              .filter(Boolean),
            maxChangedFiles: form.maxChangedFiles,
          },
          testEvidence: {
            requiredForSourceChanges: form.requireChangedTests,
            sourcePaths: form.sourcePaths
              .split(',')
              .map((path) => path.trim())
              .filter(Boolean),
            testPaths: form.testPaths
              .split(',')
              .map((path) => path.trim())
              .filter(Boolean),
          },
          protectedPaths: ['.github/workflows/', '.sdlc/'],
          setup: selectedRepository?.setup
            ? {
                ...selectedRepository.setup,
                status: reviewingDetectedSetup ? 'reviewed' : selectedRepository.setup.status,
              }
            : undefined,
          deployment: {
            enabled: form.deploymentEnabled,
            target: form.deploymentTarget,
            environment: form.environment,
            workflow: form.workflow,
            rollbackWorkflow: form.rollbackWorkflow,
            healthUrl: form.healthUrl,
            monitorIntervalSeconds: 300,
          },
        }),
      });
      setOpen(false);
      setForm(fresh);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">POLICY BOUNDARIES</p>
          <h1>Repositories</h1>
          <p>Projects opened through Codex appear here with detected commands and policies ready for review.</p>
        </div>
        <button className="button primary" onClick={() => setOpen(true)} disabled={!available.length}>
          <Plus />
          Add repository
        </button>
      </header>
      {error && (
        <div className="notice error">
          <AlertTriangle />
          {error}
        </div>
      )}
      {loading && (
        <div className="notice">
          <LoaderCircle className="spin" />
          <div>
            <strong>Loading repositories</strong>
            <p>Reading saved policies and repositories allowed by GitHub.</p>
          </div>
        </div>
      )}
      {!loading && !available.length && !repos.length && (
        <div className="notice warning">
          <Github />
          <div>
            <strong>Connect GitHub first</strong>
            <p>The setup page will verify your token and load its allowed repositories here.</p>
          </div>
        </div>
      )}
      <div className="card-grid">
        {repos.map((r) => (
          <article className="repo-card" key={r.id}>
            <div>
              <span className={`stack ${r.stack}`}>
                {r.stack === 'python' ? 'PY' : r.stack === 'typescript' ? 'TS' : 'CUSTOM'}
              </span>
              <span
                className={`badge ${['needs_confirmation', 'reviewed', 'bootstrapping'].includes(r.setup?.status || '') ? 'needs_input' : 'monitoring'}`}
              >
                {r.setup?.status === 'needs_confirmation'
                  ? 'review setup'
                  : r.setup?.status === 'reviewed'
                    ? 'start bootstrap'
                    : r.setup?.status === 'bootstrapping'
                      ? 'building SDLC'
                      : r.deployment.enabled
                        ? 'deploy governed'
                        : 'PR only'}
              </span>
            </div>
            <h2>{r.name}</h2>
            <p>
              <Github /> {r.owner}/{r.repo}
            </p>
            <div className="repo-meta">
              <span>{r.checks.length} quality gates</span>
              {!!r.setup?.capabilities.length && (
                <span>
                  {r.setup.capabilities.filter((item) => ['ready', 'not_applicable'].includes(item.status)).length}/
                  {r.setup.capabilities.length} SDLC capabilities ready
                </span>
              )}
              <span>Policy v{r.version}</span>
              <span>{r.deployment.environment}</span>
            </div>
            <button className="button quiet repo-edit" onClick={() => edit(r)}>
              <Wrench />
              {r.setup?.status === 'needs_confirmation'
                ? 'Review detected setup'
                : ['reviewed', 'bootstrapping'].includes(r.setup?.status || '')
                  ? 'View SDLC bootstrap'
                  : 'Edit policy'}
            </button>
          </article>
        ))}
      </div>
      {!repos.length && available.length > 0 && (
        <section className="panel">
          <Empty
            title="No repository selected"
            text="Choose one of the repositories authorized through the connected GitHub account."
          />
        </section>
      )}
      {open && (
        <Modal
          title={
            selectedRepository
              ? detectedSetup
                ? 'Review detected project setup'
                : 'Edit repository policy'
              : 'Add a repository'
          }
          close={() => setOpen(false)}
        >
          <form className="form" onSubmit={save}>
            {detectedSetup && (
              <div className="notice warning">
                <Bot />
                <div>
                  <strong>Codex filled this from the local checkout</strong>
                  <p>
                    {detectedSetup.status === 'needs_confirmation'
                      ? 'Confirm the stack, base branch, CI, quality gates, and deployment settings. Saving marks the details as reviewed; Codex starts the bootstrap from chat.'
                      : detectedSetup.status === 'reviewed'
                        ? 'The detected details were reviewed. Start or continue the governed prompt in Codex to create the missing foundations.'
                        : 'Codex is creating the missing foundations. This inventory remains visible until every configured gate passes.'}
                  </p>
                  {detectedSetup.evidence.length > 0 && (
                    <p className="fine-print">Detected: {detectedSetup.evidence.join(' · ')}</p>
                  )}
                  {detectedSetup.warnings.length > 0 && (
                    <p className="fine-print">Check: {detectedSetup.warnings.join(' · ')}</p>
                  )}
                </div>
              </div>
            )}
            {detectedSetup && detectedSetup.capabilities.length > 0 && (
              <section className="setup-inventory">
                <div>
                  <h3>Detected SDLC capabilities</h3>
                  <p className="fine-print">Ready parts are preserved. Codex creates only missing or partial parts.</p>
                </div>
                <div className="capability-grid">
                  {detectedSetup.capabilities.map((item) => (
                    <article className={`capability ${item.status}`} key={item.id}>
                      <strong>{item.label}</strong>
                      <span>{item.status.replace('_', ' ')}</span>
                      <small>{item.evidence.join(' · ')}</small>
                    </article>
                  ))}
                </div>
                {detectedSetup.tasks.length > 0 && (
                  <details>
                    <summary>{detectedSetup.tasks.length} bootstrap tasks proposed</summary>
                    <ol className="bootstrap-list">
                      {detectedSetup.tasks.map((item) => (
                        <li key={item.id}>
                          <strong>{item.title}</strong>
                          <span>{item.reason}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </section>
            )}
            <label>
              GitHub repository
              <select
                required
                value={form.owner && form.repo ? `${form.owner}/${form.repo}` : ''}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="">Choose repository…</option>
                {selectedFullName && !selectedIsAvailable && (
                  <option value={selectedFullName}>{selectedFullName} · local checkout</option>
                )}
                {available.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? ' · private' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="two">
              <label>
                Stack
                <select
                  value={form.stack}
                  onChange={(e) =>
                    setForm({ ...form, stack: e.target.value as 'typescript' | 'python' | 'custom', checksJson: '' })
                  }
                >
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              <label>
                Base branch
                <input required value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
              </label>
              <label>
                Required CI checks
                <input
                  value={form.requiredCiChecks}
                  onChange={(e) => setForm({ ...form, requiredCiChecks: e.target.value })}
                  placeholder="ci, security"
                />
              </label>
              <label>
                Environment
                <input
                  required
                  value={form.environment}
                  onChange={(e) => setForm({ ...form, environment: e.target.value })}
                />
              </label>
            </div>
            <label>
              CI waiver when no checks are required
              <input
                value={form.ciWaiver}
                onChange={(e) => setForm({ ...form, ciWaiver: e.target.value })}
                placeholder="Document why remote CI is not required"
              />
            </label>
            <label>
              Company and repository standards
              <textarea
                rows={4}
                value={form.standards}
                onChange={(e) => setForm({ ...form, standards: e.target.value })}
                placeholder="Optional rules specific to this repository"
              />
            </label>
            <h3>Independent review</h3>
            <div className="two">
              <label>
                Review mode
                <select
                  value={form.reviewMode}
                  onChange={(e) => setForm({ ...form, reviewMode: e.target.value as 'always' | 'risk-based' })}
                >
                  <option value="risk-based">Risk based</option>
                  <option value="always">Every change</option>
                </select>
              </label>
              <label>
                Review from risk level
                <select
                  value={form.minimumRisk}
                  onChange={(e) => setForm({ ...form, minimumRisk: e.target.value as 'low' | 'medium' | 'high' })}
                  disabled={form.reviewMode === 'always'}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label>
                Review when changed files exceed
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={form.maxChangedFiles}
                  onChange={(e) => setForm({ ...form, maxChangedFiles: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              Sensitive path globs
              <input
                value={form.sensitivePaths}
                onChange={(e) => setForm({ ...form, sensitivePaths: e.target.value })}
                placeholder="**/auth/**, **/payments/**"
              />
            </label>
            <h3>Acceptance test evidence</h3>
            <label>
              Source changes require changed tests
              <select
                value={form.requireChangedTests ? 'required' : 'optional'}
                onChange={(e) => setForm({ ...form, requireChangedTests: e.target.value === 'required' })}
              >
                <option value="required">Required</option>
                <option value="optional">Optional</option>
              </select>
            </label>
            {form.requireChangedTests && (
              <div className="two">
                <label>
                  Source path globs
                  <input value={form.sourcePaths} onChange={(e) => setForm({ ...form, sourcePaths: e.target.value })} />
                </label>
                <label>
                  Test path globs
                  <input value={form.testPaths} onChange={(e) => setForm({ ...form, testPaths: e.target.value })} />
                </label>
              </div>
            )}
            <details>
              <summary>Advanced quality gates</summary>
              <p className="fine-print">
                Recommended TypeScript gates include build, lint, types, isolated unit and integration suites, browser
                E2E, secrets, SAST, and dependency audit. Company-specific scanners can be added here.
              </p>
              {profiles[form.stack] && (
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => setForm({ ...form, checksJson: JSON.stringify(profiles[form.stack], null, 2) })}
                >
                  <RefreshCw />
                  Use recommended gates
                </button>
              )}
              <textarea
                rows={12}
                value={form.checksJson || JSON.stringify(profiles[form.stack] || [], null, 2)}
                onChange={(e) => setForm({ ...form, checksJson: e.target.value })}
              />
            </details>
            <h3>Deployment</h3>
            <label>
              Release automation
              <select
                value={form.deploymentEnabled ? 'enabled' : 'disabled'}
                onChange={(e) => setForm({ ...form, deploymentEnabled: e.target.value === 'enabled' })}
              >
                <option value="disabled">Create PR and stop after CI</option>
                <option value="enabled">Require approval and deploy</option>
              </select>
            </label>
            {form.deploymentEnabled && (
              <>
                <label>
                  Deployment target
                  <input
                    required
                    value={form.deploymentTarget}
                    onChange={(e) => setForm({ ...form, deploymentTarget: e.target.value })}
                    placeholder="Azure staging, AWS ECS, Vercel, internal platform…"
                  />
                </label>
                <label>
                  Staging health URL
                  <input
                    required
                    type="url"
                    value={form.healthUrl}
                    onChange={(e) => setForm({ ...form, healthUrl: e.target.value })}
                    placeholder="https://staging.example.com/health"
                  />
                </label>
                <div className="two">
                  <label>
                    Deployment workflow
                    <input
                      required
                      value={form.workflow}
                      onChange={(e) => setForm({ ...form, workflow: e.target.value })}
                    />
                  </label>
                  <label>
                    Rollback workflow
                    <input
                      required
                      value={form.rollbackWorkflow}
                      onChange={(e) => setForm({ ...form, rollbackWorkflow: e.target.value })}
                    />
                  </label>
                </div>
              </>
            )}
            <div className="modal-actions">
              <button type="button" className="button quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="button primary">
                {reviewingDetectedSetup ? 'Save reviewed setup' : 'Save repository'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function KnowledgePage() {
  const [docs, setDocs] = useState<(Omit<Document, 'content'> & { excerpt: string })[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', source: '', owner: '', content: '' });
  const load = () =>
    api<typeof docs>('/api/documents')
      .then(setDocs)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/api/documents', { method: 'POST', body: JSON.stringify(form) });
      setOpen(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">GROUNDED CONTEXT</p>
          <h1>Company knowledge</h1>
          <p>Versioned policies, architecture, domain rules, and incident lessons.</p>
        </div>
        <button className="button primary" onClick={() => setOpen(true)}>
          <Plus />
          Add document
        </button>
      </header>
      {error && (
        <div className="notice error">
          <AlertTriangle />
          {error}
        </div>
      )}
      <div className="doc-list">
        {docs.map((d) => (
          <article className="doc" key={d.id}>
            <BookOpen />
            <div>
              <span className="eyebrow">{d.source || 'INTERNAL DOCUMENT'}</span>
              <h2>{d.title}</h2>
              <p>{d.excerpt}</p>
              <small>
                Owner {d.owner} · version {d.version} · sha256 {d.hash.slice(0, 12)}…
              </small>
            </div>
          </article>
        ))}
      </div>
      {!docs.length && (
        <section className="panel">
          <Empty
            title="No company context yet"
            text="Add approved policies or architecture notes. Runs cite the exact versions they used."
          />
        </section>
      )}
      {open && (
        <Modal title="Add company knowledge" close={() => setOpen(false)}>
          <form className="form" onSubmit={save}>
            <div className="two">
              <label>
                Title
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </label>
              <label>
                Owner
                <input required value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
              </label>
            </div>
            <label>
              Source reference
              <input
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
                placeholder="Security policy / ADR-004 / incident 2026-12"
              />
            </label>
            <label>
              Approved content
              <textarea
                required
                rows={12}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="button quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="button primary">Version document</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function SetupPage({ navigate }: { navigate: (page: string) => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api<SetupState>('/api/setup')
      .then(setState)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const complete = !!state?.github;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">THREE-STEP ONBOARDING</p>
          <h1>Connect and start</h1>
          <p>Keep your existing Codex login and local project checkout.</p>
        </div>
        {complete && (
          <button className="button primary" onClick={() => navigate('runs')}>
            <LayoutDashboard />
            View runs
          </button>
        )}
      </header>
      {error && (
        <div className="notice error">
          <AlertTriangle />
          {error}
        </div>
      )}
      <div className="setup-steps">
        <section className="setup-card complete">
          <div className="setup-number">1</div>
          <div className="setup-copy">
            <span className="eyebrow">CODING AGENT</span>
            <h2>Use your Codex app or CLI</h2>
            <p>
              Run <code>.\connect-codex.ps1</code> once. It updates your Codex configuration without changing the
              project. There is no second Codex login, clone, or Docker worker.
            </p>
            <p>
              Start feature work in native Plan mode so Codex can ask its normal questions. After you choose to
              implement, the governed run begins. When Testing requests it, type <code>/review</code> in the same
              project to run Codex's dedicated reviewer.
            </p>
          </div>
          <SetupStatus label="Connected" />
        </section>
        <section className={`setup-card ${state?.githubLogin ? 'complete' : ''}`}>
          <div className="setup-number">2</div>
          <div className="setup-copy">
            <span className="eyebrow">SOURCE CONTROL</span>
            <h2>GitHub identity and local Git</h2>
            {state?.githubLogin ? (
              <p>
                Signed in as @{state.githubLogin}. Browser login only verifies your identity. Repository work uses this
                checkout and your existing local Git credentials
                {state.github ? ', which are ready for optional PR and CI automation.' : '.'}
              </p>
            ) : state?.githubOAuth ? (
              <>
                <p>Sign in through GitHub without granting repository, organization, or workflow access.</p>
                <a className="button primary" href="/auth/github">
                  <Github /> Continue with GitHub
                </a>
              </>
            ) : (
              <p>
                GitHub sign-in has not been enabled by the application administrator. End users never need to create an
                OAuth application or paste a personal access token.
              </p>
            )}
          </div>
          <div>{state?.githubLogin && <SetupStatus label="Signed in" />}</div>
        </section>
        <section className="setup-card complete">
          <div className="setup-number">3</div>
          <div className="setup-copy">
            <span className="eyebrow">REPOSITORY POLICY</span>
            <h2>Open your project in Codex</h2>
            <p>
              The first governed prompt inventories the repository, asks about uncertain choices, and includes every
              missing SDLC foundation in the native implementation plan.
            </p>
          </div>
          <div>
            <SetupStatus label={state?.repositories ? 'Configured' : 'Automatic on first prompt'} />
          </div>
        </section>
      </div>
    </>
  );
}
function SetupStatus({ label }: { label: string }) {
  return (
    <span className="setup-status">
      <CheckCircle2 />
      {label}
    </span>
  );
}
function SystemPage() {
  const [ready, setReady] = useState<Record<string, unknown>>({});
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: '',
    url: '',
    allowedTools: '',
    contextTool: '',
    contextArgs: '{"query":"{{prompt}}"}',
    headerEnv: '{}',
  });
  const load = () =>
    Promise.all([api<Record<string, unknown>>('/api/readiness'), api<Integration[]>('/api/integrations')])
      .then(([r, i]) => {
        setReady(r);
        setIntegrations(i);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const allowedTools = form.allowedTools
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const contextCalls = form.contextTool
        ? [{ tool: form.contextTool, arguments: JSON.parse(form.contextArgs) }]
        : [];
      await api('/api/integrations', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          url: form.url,
          allowedTools,
          enabled: true,
          headersEnv: JSON.parse(form.headerEnv),
          contextCalls,
        }),
      });
      setOpen(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">TRUSTED INFRASTRUCTURE</p>
          <h1>System readiness</h1>
          <p>A missing dependency blocks work; it never becomes a silent pass.</p>
        </div>
        <div className="head-actions">
          <button className="button quiet" onClick={load}>
            <RefreshCw />
            Refresh
          </button>
          <button className="button primary" onClick={() => setOpen(true)}>
            <Plus />
            Add MCP
          </button>
        </div>
      </header>
      {error && <div className="notice error">{error}</div>}
      <section className="panel">
        <pre className="system-json">{JSON.stringify(ready, null, 2)}</pre>
      </section>
      <section className="principles">
        <article>
          <ShieldCheck />
          <h2>Controller decides</h2>
          <p>Agent completion only creates a candidate. Gates and cited evidence establish acceptance.</p>
        </article>
        <article>
          <Boxes />
          <h2>Native workspace</h2>
          <p>Checks run in the developer's current checkout and bind evidence to its exact Git tree.</p>
        </article>
        <article>
          <Rocket />
          <h2>Approved releases</h2>
          <p>Every deployment decision names an immutable revision, environment, and workflow.</p>
        </article>
      </section>
      <section className="panel integration-panel">
        <div className="panel-head">
          <div>
            <h2>Company MCP integrations</h2>
            <p>Administrator-owned allowlists and context calls</p>
          </div>
          <span className="badge monitoring">{integrations.length} configured</span>
        </div>
        {integrations.length ? (
          <div className="run-list">
            {integrations.map((i) => (
              <div className="integration-row" key={i.id}>
                <span>
                  <BotIcon />
                </span>
                <div>
                  <strong>{i.name}</strong>
                  <small>{i.url}</small>
                </div>
                <div>
                  <small>{i.allowedTools.join(', ') || 'No tools'}</small>
                </div>
                <Badge status={i.enabled ? 'monitoring' : 'blocked'} />
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="No MCP integrations"
            text="Add approved internal search or tool servers for company-specific context."
            compact
          />
        )}
      </section>
      {open && (
        <Modal title="Configure a company MCP" close={() => setOpen(false)}>
          <form className="form" onSubmit={save}>
            <label>
              Name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              Streamable HTTP endpoint
              <input type="url" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </label>
            <label>
              Allowed tools, comma separated
              <input
                required
                value={form.allowedTools}
                onChange={(e) => setForm({ ...form, allowedTools: e.target.value })}
                placeholder="search_documents,get_architecture"
              />
            </label>
            <label>
              Discovery context tool
              <input
                value={form.contextTool}
                onChange={(e) => setForm({ ...form, contextTool: e.target.value })}
                placeholder="search_documents"
              />
            </label>
            <label>
              Context arguments JSON
              <textarea
                rows={3}
                value={form.contextArgs}
                onChange={(e) => setForm({ ...form, contextArgs: e.target.value })}
              />
            </label>
            <label>
              HTTP header to server environment mapping JSON
              <textarea
                rows={3}
                value={form.headerEnv}
                onChange={(e) => setForm({ ...form, headerEnv: e.target.value })}
                placeholder='{"Authorization":"INTERNAL_MCP_AUTH"}'
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="button quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="button primary">Connect and inspect</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function BotIcon() {
  return <Bot />;
}
function Empty({ title, text, compact = false }: { title: string; text: string; compact?: boolean }) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <Circle />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-bg" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={close}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [page, setPage] = useState('setup');
  const [runId, setRunId] = useState<string | null>(null);
  const loadMe = () =>
    api<Me>('/api/me').then((m) => {
      csrf = m.csrf;
      setMe(m);
    });
  useEffect(() => {
    loadMe();
  }, []);
  if (!me)
    return (
      <div className="loading">
        <LoaderCircle className="spin" />
      </div>
    );
  if (!me.user) return <Login me={me} />;
  async function logout() {
    await api('/api/logout', { method: 'POST' });
    csrf = '';
    loadMe();
  }
  const navigate = (p: string) => {
    setPage(p);
    setRunId(null);
  };
  return (
    <Shell me={me} page={page} setPage={navigate} logout={logout}>
      {runId ? (
        <RunDetail id={runId} back={() => setRunId(null)} />
      ) : page === 'setup' ? (
        <SetupPage navigate={navigate} />
      ) : page === 'runs' ? (
        <RunsPage onOpen={setRunId} />
      ) : page === 'repositories' ? (
        <RepositoriesPage />
      ) : page === 'knowledge' ? (
        <KnowledgePage />
      ) : (
        <SystemPage />
      )}
    </Shell>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
