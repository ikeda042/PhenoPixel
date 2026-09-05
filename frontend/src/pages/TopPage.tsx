import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, ChartNoAxesCombined, Database, Folder, Github, Microscope, ScanLine, Table2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ReloadButton, { runGitPullUpdate } from '../components/ReloadButton'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { getApiBase } from '../utils/apiBase'
import './TopPage.css'

type ActivityPoint = {
  date: string
  count: number
}

type Tool = {
  title: string
  description: string
  path: string
  icon: LucideIcon
}

const singleCellTools: Tool[] = [
  {
    title: 'Cell Extraction',
    description: 'Upload ND2 files and extract cells.',
    path: '/nd2files',
    icon: ScanLine,
  },
  {
    title: 'Database Console',
    description: 'View cells, edit labels, and run batch analysis.',
    path: '/databases',
    icon: Database,
  },
  {
    title: 'Graph Engine',
    description: 'Plot and analyze measurements from CSV files.',
    path: '/graph-engine',
    icon: ChartNoAxesCombined,
  },
]

const motherMachineTools: Tool[] = [
  {
    title: 'Cell Extraction',
    description: 'Process ND2 files by field, channel, and time.',
    path: '/mother-machine/nd2files',
    icon: Microscope,
  },
  {
    title: 'Databases',
    description: 'Review and download extracted cells.',
    path: '/mother-machine/databases',
    icon: Database,
  },
  {
    title: 'Create dataset',
    description: 'Prepare or continue a teaching dataset.',
    path: '/mother-machine/create-dataset',
    icon: Table2,
  },
]

const formatDate = (value: string) => {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const ToolList = ({ tools }: { tools: Tool[] }) => (
  <ul className="home-tools">
    {tools.map((tool) => (
      <li key={tool.path}>
        <Link to={tool.path}>
          <span className="home-tool-name">
            <tool.icon className="home-link-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
            {tool.title}
          </span>
          <span className="home-tool-description">{tool.description}</span>
        </Link>
      </li>
    ))}
  </ul>
)

export default function TopPage() {
  const apiBase = useMemo(() => getApiBase(), [])
  const [backendStatus, setBackendStatus] = useState<'ready' | 'error' | null>(null)
  const [internetStatus, setInternetStatus] = useState<boolean | null>(null)
  const [activityStatus, setActivityStatus] = useState<'idle' | 'loading' | 'error' | 'ready'>('idle')
  const [activityPoints, setActivityPoints] = useState<ActivityPoint[]>([])
  const topPageTrackedRef = useRef(false)

  const checkBackend = useCallback(async () => {
    if (!apiBase) {
      setBackendStatus(null)
      return
    }
    try {
      const res = await fetch(`${apiBase}/health`)
      setBackendStatus(res.ok ? 'ready' : 'error')
    } catch {
      setBackendStatus('error')
    }
  }, [apiBase])

  useEffect(() => {
    setInternetStatus(navigator.onLine)
    const updateOnline = () => setInternetStatus(true)
    const updateOffline = () => setInternetStatus(false)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOffline)
    return () => {
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOffline)
    }
  }, [])

  useEffect(() => {
    checkBackend()
  }, [checkBackend])

  useEffect(() => {
    if (!apiBase) return
    void runGitPullUpdate(apiBase).catch((error) => {
      console.error('Auto update failed:', error)
    })
  }, [apiBase])

  useEffect(() => {
    if (!apiBase || topPageTrackedRef.current) return
    topPageTrackedRef.current = true
    fetch(`${apiBase}/activity/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_name: 'top_page' }),
    }).catch(() => {})
  }, [apiBase])

  useEffect(() => {
    if (!apiBase) return
    let isMounted = true
    const controller = new AbortController()

    const loadActivity = async () => {
      setActivityStatus('loading')
      try {
        const res = await fetch(`${apiBase}/activity/weekly?days=7`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Failed to load activity')
        const data = await res.json()
        if (!isMounted) return
        const points = Array.isArray(data?.points) ? data.points : []
        setActivityPoints(points)
        setActivityStatus('ready')
      } catch {
        if (!isMounted || controller.signal.aborted) return
        setActivityPoints([])
        setActivityStatus('error')
      }
    }

    loadActivity()

    return () => {
      isMounted = false
      controller.abort()
    }
  }, [apiBase])

  const activityTotal = activityPoints.reduce((sum, point) => sum + point.count, 0)
  const activityAverage = activityPoints.length ? Number((activityTotal / activityPoints.length).toFixed(1)) : 0
  const activityPeak = activityPoints.length ? Math.max(...activityPoints.map((point) => point.count)) : 0
  const activityRange = activityPoints.length
    ? `${formatDate(activityPoints[0].date)} – ${formatDate(activityPoints[activityPoints.length - 1].date)}`
    : 'Last 7 days'
  const hasActivity = activityStatus === 'ready' && activityPoints.length > 0

  return (
    <div className="home-page">
      <a className="home-skip-link" href="#home-main">Skip to content</a>
      <header className="home-header">
        <div className="home-header-inner">
          <Link to="/" className="home-brand" aria-label="PhenoPixel home">
            <img src="/favicon.png" alt="" width="23" height="23" />
            <span>PhenoPixel</span>
          </Link>
          <div className="home-header-actions">
            <ReloadButton compact />
            <ThemeToggleButton compact />
          </div>
        </div>
      </header>

      <main id="home-main" className="home-main" tabIndex={-1}>
        <h1>Home</h1>
        <div className="home-columns">
          <div className="home-analysis">
            <section aria-labelledby="single-cell-heading">
              <h2 id="single-cell-heading">Single-cell analysis</h2>
              <ToolList tools={singleCellTools} />
            </section>
            <section aria-labelledby="mother-machine-heading">
              <h2 id="mother-machine-heading">Mother Machine</h2>
              <ToolList tools={motherMachineTools} />
            </section>
          </div>

          <aside className="home-sidebar" aria-label="Resources and activity">
            <section aria-labelledby="resources-heading">
              <h2 id="resources-heading">Resources</h2>
              <ul className="home-resource-links">
                <li>
                  <Link to="/files">
                    <Folder className="home-link-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
                    File Manager
                  </Link>
                </li>
                <li>
                  <a href="/docs/">
                    <BookOpen className="home-link-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
                    Documentation
                  </a>
                </li>
                <li>
                  <a href="https://github.com/ikeda042/PhenoPixel" target="_blank" rel="noopener noreferrer">
                    <Github className="home-link-icon" size={16} strokeWidth={1.5} aria-hidden="true" />
                    GitHub
                  </a>
                </li>
              </ul>
            </section>

            <details className="home-activity" open>
              <summary>Activity</summary>
              <div className="home-activity-content" aria-busy={activityStatus === 'loading' || activityStatus === 'idle'}>
                <p className="home-activity-period">{activityRange}</p>
                {hasActivity ? (
                  <>
                    <dl className="home-metrics">
                      <div><dt>Total actions</dt><dd>{activityTotal}</dd></div>
                      <div><dt>Daily average</dt><dd>{activityAverage}</dd></div>
                      <div><dt>Peak day</dt><dd>{activityPeak}</dd></div>
                    </dl>
                    <table className="home-activity-table" aria-label="Daily action counts">
                      <thead><tr><th scope="col">Day</th><th scope="col">Actions</th></tr></thead>
                      <tbody>
                        {activityPoints.map((point) => (
                          <tr key={point.date}>
                            <th scope="row"><time dateTime={point.date}>{formatDate(point.date)}</time></th>
                            <td>{point.count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="home-activity-message" role="status">
                    {activityStatus === 'error'
                      ? 'Activity data unavailable.'
                      : activityStatus === 'ready'
                        ? 'No activity recorded yet.'
                        : 'Loading activity…'}
                  </p>
                )}
              </div>
            </details>
          </aside>
        </div>

        <footer className="home-footer" role="status" aria-label="Connection status">
          <span data-state={backendStatus === 'error' ? 'error' : undefined}>
            Backend: {backendStatus === 'ready' ? 'connected' : backendStatus === 'error' ? 'unavailable' : 'checking…'}
          </span>
          <span data-state={internetStatus === false ? 'error' : undefined}>
            Network: {internetStatus === null ? 'checking…' : internetStatus ? 'online' : 'offline'}
          </span>
        </footer>
      </main>
    </div>
  )
}
