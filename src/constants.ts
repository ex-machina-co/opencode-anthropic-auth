export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const AUTHORIZE_URLS = {
  console: 'https://platform.claude.com/oauth/authorize',
  max: 'https://claude.ai/oauth/authorize',
} as const

export const CODE_CALLBACK_URL =
  'https://platform.claude.com/oauth/code/callback'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

export const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

export const TOOL_PREFIX = 'mcp_'

export const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
]

export const OPENCODE_IDENTITY =
  'You are OpenCode, the best coding agent on the planet.'
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

export const USER_AGENT = 'claude-cli/2.1.2 (external, cli)'

export const PRESERVED_TAIL_MARKERS = [
  '\nInstructions from: ',
  '\nInstructions from command: ',
  '# Code References',
]
