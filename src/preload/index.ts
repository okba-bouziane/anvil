import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, PitooApi, TerminalEvent } from '../shared/types'

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(`pitoo:${name}`, ...args)
const names = ['steer', 'claudeCodeCommand', 'openClaudeCodeGuide', 'importVscodeKeybindings', 'recoverySave', 'recoveryClear', 'recoveryList', 'filesExist', 'claudeSessions', 'importClaudeSessions', 'intel', 'listScripts', 'replaceInProject', 'suggest', 'cancelSuggest', 'openRelease', 'uiGet', 'uiSet', 'closeProject', 'workspaceAddFolder', 'workspaceRemoveFolder', 'workspaceSave', 'workspaceOpen', 'openFileDialog', 'gitClone', 'gitSelectRepo', 'gitStatusAll', 'vscodeTasks', 'vscodeLaunch', 'extensionsSearch', 'extensionsInstalled', 'extensionsInstall', 'extensionsUninstall', 'newWindow', 'installCommand', 'debugStart', 'debugStop', 'debugBreakpoints', 'debugControl', 'debugScopes', 'debugVariables', 'debugEvaluate', 'debugPython', 'lspStatus', 'lspOpen', 'lspChange', 'lspClose', 'lspRequest', 'toolingStatus', 'toolingTrust', 'tooling', 'revealPath', 'readImage', 'gitHead', 'gitDetails', 'gitPullRequests', 'gitOp', 'appVersion', 'checkUpdate', 'downloadUpdate', 'applyUpdate', 'importVscode', 'importedAssets', 'localSetup', 'createPath', 'renamePath', 'deletePath', 'searchProject', 'gitStatus', 'gitInit', 'gitStage', 'gitDiscard', 'gitCommit', 'gitSync', 'gitDiff', 'gitLog', 'gitCommitFiles', 'gitCommitDiff', 'gitBlame', 'gitBranches', 'gitCheckout', 'terminalCreate', 'terminalWrite', 'terminalResize', 'terminalKill', 'getSettings', 'setSettings', 'modelStatus', 'startModel', 'stopModel', 'listModels', 'switchLocalModel', 'keyStatus', 'setApiKey', 'clearApiKey', 'initialProject', 'openProject', 'openProjectPath', 'listDir', 'listFiles', 'readFile', 'writeFile', 'send', 'cancel', 'answerApproval', 'newChat', 'switchChat', 'deleteChat', 'getDiff', 'acceptFile', 'rejectFile', 'acceptHunk', 'rejectHunk', 'acceptAll', 'rejectAll', 'undoCheckpoint'] as const

const api = Object.fromEntries(names.map((n) => [n, call(n)])) as unknown as PitooApi
api.onEvent = (listener) => {
  const wrapped = (_: unknown, event: AgentEvent) => listener(event)
  ipcRenderer.on('pitoo:event', wrapped)
  return () => ipcRenderer.removeListener('pitoo:event', wrapped)
}
api.onTerminal = (listener) => {
  const wrapped = (_: unknown, event: TerminalEvent) => listener(event)
  ipcRenderer.on('pitoo:terminal', wrapped)
  return () => ipcRenderer.removeListener('pitoo:terminal', wrapped)
}
api.platform = process.platform
contextBridge.exposeInMainWorld('pitoo', api)
