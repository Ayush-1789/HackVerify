export function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const trimmed = repoUrl.trim();
  
  // Match standard https link
  const httpsMatch = trimmed.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  
  // Match git ssh link
  const sshMatch = trimmed.match(/git@github\.com:([^/]+)\/([^/.]+)\.git/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  
  return null;
}

export async function fetchCandidateCommits(
  owner: string,
  repo: string,
  username: string
): Promise<any[]> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ai-interview-hackathon-evaluator'
  };
  
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?author=${username}&per_page=5`,
    { headers }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Repository ${owner}/${repo} or user ${username} not found on GitHub.`);
    }
    const body = await response.text();
    throw new Error(`GitHub API error (${response.status}): ${body}`);
  }

  return await response.json();
}

export async function fetchCommitDetails(
  owner: string,
  repo: string,
  sha: string
): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'ai-interview-hackathon-evaluator'
  };
  
  if (token) {
    headers['Authorization'] = `token ${token}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
    { headers }
  );

  if (!response.ok) {
    return null;
  }

  return await response.json();
}

export async function summarizeCandidateActivity(
  repoUrl: string,
  username: string
): Promise<any> {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    throw new Error('Invalid GitHub repository URL.');
  }

  const { owner, repo } = parsed;
  const commits = await fetchCandidateCommits(owner, repo, username);

  if (!commits || commits.length === 0) {
    return [];
  }

  const summaries = [];
  // Pull details for the 3 most recent commits to fit context limits comfortably
  const recentCommits = commits.slice(0, 3);

  for (const commit of recentCommits) {
    const sha = commit.sha;
    const message = commit.commit.message;
    const date = commit.commit.author.date;

    const detail = await fetchCommitDetails(owner, repo, sha);
    const files = [];

    if (detail && detail.files) {
      for (const file of detail.files.slice(0, 3)) {
        // Capture filename, additions, deletions, and a small snippet of diff patch
        files.push({
          filename: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ? file.patch.slice(0, 400) : '' // Limit patch length
        });
      }
    }

    summaries.push({
      sha: sha.slice(0, 7),
      message,
      date,
      files
    });
  }

  return summaries;
}
