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
  Clock3,
  Code2,
  Database,
  FileCheck2,
  GitBranch,
  Github,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  TerminalSquare,
  UserCheck,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import type { Document, Integration, Repository, Run, User } from '../../../shared/types.ts';
import './styles.css';
type Me = { user: User | null; csrf: string; githubOAuth: boolean; passwordLogin: boolean };
type RunBundle = {
  run: Run;
  events: { id: number; time: string; kind: string; message: string }[];
  artifacts: { id: string; name: string; hash: string; createdAt: string }[];
};
type SetupState = { github: boolean; repositories: number };
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
function Login({ me, refresh }: { me: Me; refresh: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  async function login(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: JSON.stringify({ password: token }) });
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }
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
        {me.githubOAuth && (
          <a className="button primary wide" href="/auth/github">
            <Github size={17} /> Continue with GitHub
          </a>
        )}
        {me.passwordLogin && (
          <form onSubmit={login} className="dev-login">
            <label>Administrator password</label>
            <div className="input-action">
              <KeyRound size={16} />
              <input
                aria-label="Administrator password"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Administrator password"
              />
              <button>Sign in</button>
            </div>
          </form>
        )}
        {error && (
          <p className="error">
            <AlertTriangle size={15} />
            {error}
          </p>
        )}
        <p className="fine-print">
          Access is restricted to configured team members. Every approval and policy change is audited.
        </p>
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
    ) : status === 'awaiting_approval' || status === 'needs_input' ? (
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
  const active = runs.filter((r) => ['running', 'repairing', 'needs_input', 'awaiting_approval'].includes(r.status));
  const attention = runs.filter((r) => ['failed', 'blocked', 'cancelled'].includes(r.status));
  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">ENGINEERING OPERATIONS</p>
          <h1>Development runs</h1>
          <p>Seven phases, one accountable record.</p>
        </div>
        <span className="badge monitoring">Native Codex connected</span>
      </header>
      <div className="metric-grid">
        <Metric label="Active runs" value={active.length} detail="Across configured repositories" icon={Activity} />
        <Metric
          label="Awaiting approval"
          value={runs.filter((r) => r.status === 'awaiting_approval').length}
          detail="Deployment decisions"
          icon={UserCheck}
        />
        <Metric
          label="Under maintenance"
          value={runs.filter((r) => r.status === 'monitoring').length}
          detail="Live release monitors"
          icon={Wrench}
        />
        <Metric
          label="Needs attention"
          value={attention.length}
          detail="Failed, blocked, or cancelled"
          icon={AlertTriangle}
        />
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
                  <strong>{run.contract?.summary || run.prompt}</strong>
                  <span>
                    {run.policy.owner}/{run.policy.repo} · native Codex session
                  </span>
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
function RunDetail({ id, back }: { id: string; back: () => void }) {
  const [bundle, setBundle] = useState<RunBundle | null>(null);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [approve, setApprove] = useState(false);
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
  return (
    <>
      <header className="detail-head">
        <button className="back" onClick={back}>
          ← Runs
        </button>
        <div className="detail-title">
          <div>
            <p className="eyebrow">RUN {run.id.slice(0, 8).toUpperCase()}</p>
            <h1>{run.contract?.summary || run.prompt}</h1>
            <p>
              {run.policy.owner}/{run.policy.repo} · candidate{' '}
              {(run.candidateSha || run.candidateDigest)?.slice(0, 9) || 'pending'}
            </p>
          </div>
          <Badge status={run.status} />
        </div>
        <PhaseRail run={run} />
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
      <div className="detail-grid">
        <section className="panel span2">
          <div className="panel-head">
            <div>
              <h2>Lifecycle evidence</h2>
              <p>{run.step.replaceAll('-', ' ')}</p>
            </div>
            <a className="button quiet" href={`/api/runs/${id}/report`}>
              <FileCheck2 />
              Report
            </a>
          </div>
          <div className="evidence-grid">
            <Evidence title="Planning" icon={Clock3} ready={!!run.plan}>
              <p>{run.plan?.scope || 'Pending'}</p>
              {run.plan && (
                <small>
                  {run.plan.estimatedEffort} · {run.plan.costEstimate}
                </small>
              )}
            </Evidence>
            <Evidence title="Requirements" icon={Archive} ready={!!run.contract}>
              <p>{run.contract ? `${run.contract.criteria.length} acceptance criteria` : 'Pending'}</p>
              {run.contract?.criteria.slice(0, 3).map((c) => (
                <small key={c.id}>
                  {c.id} · {c.description}
                </small>
              ))}
            </Evidence>
            <Evidence title="Design" icon={Boxes} ready={!!run.design}>
              <p>{run.design?.architecture || 'Pending'}</p>
            </Evidence>
            <Evidence title="Implementation" icon={TerminalSquare} ready={!!run.candidateDigest}>
              <p>{run.candidateDigest ? `Verified tree ${run.candidateDigest.slice(0, 12)}` : 'Pending'}</p>
              <small>{run.attempt} repair attempts</small>
            </Evidence>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Quality gates</h2>
              <p>Bound to candidate revision</p>
            </div>
            <ShieldCheck />
          </div>
          <div className="gate-list">
            {!run.gates.length ? (
              <Empty title="Verification pending" text="Gates appear after implementation." compact />
            ) : (
              run.gates.map((g) => (
                <div className="gate" key={g.id}>
                  <span className={g.status}>
                    <GateIcon status={g.status} />
                  </span>
                  <div>
                    <strong>{g.label}</strong>
                    <small>
                      {g.tests === null ? 'Command' : `${g.tests} tests`} · {g.durationMs}ms
                    </small>
                  </div>
                  <Badge status={g.status} />
                </div>
              ))
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Self-review</h2>
              <p>Acceptance evidence checked in the same Codex session</p>
            </div>
            <Search />
          </div>
          {run.review ? (
            <>
              <p className="review-summary">{run.review.summary}</p>
              {run.review.findings.map((f) => (
                <div className="finding" key={f.id}>
                  <span className={f.severity}>{f.severity}</span>
                  <div>
                    <strong>
                      {f.file}:{f.line}
                    </strong>
                    <p>{f.description}</p>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <Empty title="Review pending" text="Review begins after automated gates pass." compact />
          )}
        </section>
        <section className="panel span2">
          <div className="panel-head">
            <div>
              <h2>Activity</h2>
              <p>Durable controller events</p>
            </div>
            <Activity />
          </div>
          <div className="timeline">
            {bundle.events
              .slice()
              .reverse()
              .map((e) => (
                <div key={e.id}>
                  <span>
                    <Circle />
                  </span>
                  <time>{new Date(e.time).toLocaleTimeString()}</time>
                  <b>{e.kind.replaceAll('-', ' ')}</b>
                  <p>{e.message}</p>
                </div>
              ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Artifacts</h2>
              <p>Hashed source and evidence</p>
            </div>
            <Database />
          </div>
          <div className="artifact-list">
            {bundle.artifacts.map((a) => (
              <a href={`/api/artifacts/${a.id}`} key={a.id}>
                <FileCheck2 />
                <span>
                  <strong>{a.name}</strong>
                  <small>sha256 {a.hash.slice(0, 12)}…</small>
                </span>
              </a>
            ))}
          </div>
        </section>
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
function Evidence({
  title,
  icon: Icon,
  ready,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number }>;
  ready: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`evidence ${ready ? 'ready' : ''}`}>
      <div>
        <span>
          <Icon size={17} />
        </span>
        <strong>{title}</strong>
        {ready ? <CheckCircle2 /> : <Circle />}
      </div>
      {children}
    </div>
  );
}
function RepositoriesPage() {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Repository['checks']>>({});
  const [available, setAvailable] = useState<GitHubRepository[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const fresh = {
    name: '',
    owner: '',
    repo: '',
    branch: 'main',
    stack: 'typescript' as 'typescript' | 'python',
    checksJson: '',
    standards: '',
    requiredCiChecks: 'ci',
    ciWaiver: '',
    deploymentEnabled: false,
    healthUrl: '',
    workflow: 'deploy.yml',
    rollbackWorkflow: 'rollback.yml',
    environment: 'staging',
  };
  const [form, setForm] = useState(fresh);
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
      .catch((e) => setError(e.message));
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
          protectedPaths: ['.github/workflows/', '.sdlc/'],
          deployment: {
            enabled: form.deploymentEnabled,
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
          <p>Choose a connected GitHub project and define its release evidence.</p>
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
      {!available.length && !repos.length && (
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
              <span className={`stack ${r.stack}`}>{r.stack === 'python' ? 'PY' : 'TS'}</span>
              <span className="badge monitoring">{r.deployment.enabled ? 'deploy governed' : 'PR only'}</span>
            </div>
            <h2>{r.name}</h2>
            <p>
              <Github /> {r.owner}/{r.repo}
            </p>
            <div className="repo-meta">
              <span>{r.checks.length} quality gates</span>
              <span>Policy v{r.version}</span>
              <span>{r.deployment.environment}</span>
            </div>
            <PhaseRail run={{ phase: 'planning' } as Run} />
          </article>
        ))}
      </div>
      {!repos.length && available.length > 0 && (
        <section className="panel">
          <Empty
            title="No repository selected"
            text="Choose one of the repositories allowed by the connected GitHub token."
          />
        </section>
      )}
      {open && (
        <Modal title="Add a repository" close={() => setOpen(false)}>
          <form className="form" onSubmit={save}>
            <label>
              GitHub repository
              <select
                required
                value={form.owner && form.repo ? `${form.owner}/${form.repo}` : ''}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="">Choose repository…</option>
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
                    setForm({ ...form, stack: e.target.value as 'typescript' | 'python', checksJson: '' })
                  }
                >
                  <option value="typescript">TypeScript</option>
                  <option value="python">Python</option>
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
            <details>
              <summary>Advanced quality gates</summary>
              <p className="fine-print">
                The selected stack provides a safe default. Add project-specific integration or E2E commands here when
                required.
              </p>
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
              <button className="button primary">Save repository</button>
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
  const [githubToken, setGithubToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = () =>
    api<SetupState>('/api/setup')
      .then(setState)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function connectGithub(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy('github');
    try {
      await api('/api/setup/github', { method: 'POST', body: JSON.stringify({ token: githubToken }) });
      setGithubToken('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  const complete = !!state?.github && !!state?.repositories;
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
              Run <code>.\connect-codex.ps1 -ProjectPath "C:\path\to\project"</code> once. There is no second Codex
              login, clone, or Docker worker.
            </p>
          </div>
          <div>
            <Badge status="monitoring" />
          </div>
        </section>
        <section className={`setup-card ${state?.github ? 'complete' : ''}`}>
          <div className="setup-number">2</div>
          <div className="setup-copy">
            <span className="eyebrow">SOURCE CONTROL</span>
            <h2>Connect GitHub</h2>
            <p>
              Paste a fine-grained token for one controlled repository. It is verified and encrypted before storage.
            </p>
            {!state?.github && (
              <form className="inline-secret" onSubmit={connectGithub}>
                <input
                  aria-label="GitHub token"
                  type="password"
                  required
                  minLength={20}
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="github_pat_…"
                />
                <button className="button primary" disabled={busy === 'github'}>
                  <Github />
                  Verify and connect
                </button>
              </form>
            )}
            <a
              className="help-link"
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
            >
              Create a GitHub token ↗
            </a>
          </div>
          <div>{state?.github && <Badge status="monitoring" />}</div>
        </section>
        <section className={`setup-card ${state?.repositories ? 'complete' : ''}`}>
          <div className="setup-number">3</div>
          <div className="setup-copy">
            <span className="eyebrow">REPOSITORY POLICY</span>
            <h2>Choose a repository</h2>
            <p>Select the project, its quality gates, staging workflow, and health check.</p>
          </div>
          <div>
            {state?.repositories ? (
              <Badge status="monitoring" />
            ) : (
              <button className="button primary" onClick={() => navigate('repositories')}>
                <GitBranch />
                Add repository
              </button>
            )}
          </div>
        </section>
      </div>
    </>
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
  if (!me.user) return <Login me={me} refresh={loadMe} />;
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
