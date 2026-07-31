export const MAC_LOCAL_WORKSPACE_OPENERS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'sublime-text', label: 'Sublime Text' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'finder', label: 'Finder' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'iterm2', label: 'iTerm2' },
  { id: 'ghostty', label: 'Ghostty' },
  { id: 'warp', label: 'Warp' },
  { id: 'xcode', label: 'Xcode' },
  { id: 'android-studio', label: 'Android Studio' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA' },
] as const

export const WINDOWS_LOCAL_WORKSPACE_OPENERS = [
  { id: 'vscode', label: 'VS Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'sublime-text', label: 'Sublime Text' },
  { id: 'windsurf', label: 'Windsurf' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'windows-terminal', label: 'Windows Terminal' },
  { id: 'android-studio', label: 'Android Studio' },
  { id: 'intellij-idea', label: 'IntelliJ IDEA' },
] as const

export const LOCAL_WORKSPACE_OPENERS = [
  ...MAC_LOCAL_WORKSPACE_OPENERS,
  ...WINDOWS_LOCAL_WORKSPACE_OPENERS,
] as const

export const LOCAL_WORKSPACE_OPENER_PLATFORMS: Record<LocalWorkspaceOpenerId, ('mac' | 'win')[]> = {
  vscode: ['mac', 'win'],
  'vscode-insiders': ['mac', 'win'],
  cursor: ['mac', 'win'],
  'sublime-text': ['mac', 'win'],
  windsurf: ['mac', 'win'],
  finder: ['mac'],
  terminal: ['mac'],
  iterm2: ['mac'],
  ghostty: ['mac'],
  warp: ['mac'],
  xcode: ['mac'],
  'android-studio': ['mac', 'win'],
  'intellij-idea': ['mac', 'win'],
  powershell: ['win'],
  cmd: ['win'],
  'windows-terminal': ['win'],
}

export type LocalWorkspaceOpenerId = (typeof LOCAL_WORKSPACE_OPENERS)[number]['id']

export const DEFAULT_LOCAL_WORKSPACE_OPENER_ID: LocalWorkspaceOpenerId = 'vscode'

export function getWorkspaceOpenersForPlatform(
  platform: 'mac' | 'win' | 'linux'
): typeof LOCAL_WORKSPACE_OPENERS {
  if (platform === 'mac') return MAC_LOCAL_WORKSPACE_OPENERS
  if (platform === 'win') return WINDOWS_LOCAL_WORKSPACE_OPENERS
  return []
}
