type GitPullResponse = {
  status?: string
  output?: string
  detail?: string
}

export const runGitPullUpdate = async (apiBase: string): Promise<GitPullResponse> => {
  const response = await fetch(`${apiBase}/system/git-pull`, { method: 'POST' })
  const payload = (await response.json().catch(() => ({}))) as GitPullResponse
  if (!response.ok) {
    const message =
      typeof payload.detail === 'string' && payload.detail.trim()
        ? payload.detail
        : 'Update failed.'
    throw new Error(message)
  }
  if (typeof payload.output === 'string' && payload.output.trim()) {
    console.info(payload.output)
  }
  return payload
}

