export const getApiBase = () => {
  const envBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''
  const trimmedEnvBase = envBase.trim()
  if (trimmedEnvBase) {
    const normalized = trimmedEnvBase.replace(/\/$/, '')
    return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`
  }

  if (typeof window !== 'undefined') {
    if (import.meta.env.PROD) {
      const normalized = window.location.origin.replace(/\/$/, '')
      return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`
    }
    const { protocol, hostname } = window.location
    if (hostname) {
      return `${protocol}//${hostname}:3000/api/v1`
    }
  }

  return 'http://0.0.0.0:3000/api/v1'
}
