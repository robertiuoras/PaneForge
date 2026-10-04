import { useEffect, useState } from 'react'
import type { IncludedAccounts as Accounts } from '@shared/types'
import { isMac } from '../platform'
import { Why } from './Controls'
import Select from './Select'

export default function IncludedAccounts(): React.JSX.Element {
  const [target, setTarget] = useState<'local' | 'pc'>('local')
  const [accounts, setAccounts] = useState<Accounts | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let current = true
    setAccounts(null)
    setBusy(true)
    setMessage('')
    window.api.includedAccounts(target).then((value) => { if (current) setAccounts(value) })
      .catch(() => { if (current) setMessage('Account status is unavailable. Check the account manager and connection on this computer.') })
      .finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [target, refresh])
  const useAccount = async (provider: 'claude' | 'codex', email: string): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      setAccounts(await window.api.includedAccounts(target, { provider, email }))
      setMessage('Selected login confirmed. Existing sessions may retain their previous login. Plan availability is checked when the agent makes a request.')
    } catch {
      setMessage('The switch could not be confirmed. Refresh to check the selected login before continuing.')
    } finally { setBusy(false) }
  }
  return <div className="setting">
    <div className="setting-row">
      <label>Included-plan accounts</label>
      <button className="ghost small" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
    </div>
    {isMac && <Select size="sm" title="Account computer" value={target} disabled={busy}
      options={[{ value: 'local', label: 'This Mac' }, { value: 'pc', label: 'PC' }]}
      onChange={(v) => setTarget(v as 'local' | 'pc')} />}
    <p className="hint">Saved Claude and Codex logins; one press switches.</p>
    {busy && <p className="hint">Checking account selection…</p>}
    {accounts && (['claude', 'codex'] as const).map((provider) => <div key={provider}>
      <p>{provider === 'claude' ? 'Claude' : 'Codex'}: {accounts[provider].live || 'Signed out'}</p>
      {accounts[provider].saved.map((account) => <div className="setting-row" key={account.email}>
        <span>{account.email}{account.plan ? ` (${account.plan})` : ''}</span>
        <button className="ghost small" disabled={busy || account.email === accounts[provider].live} onClick={() => void useAccount(provider, account.email)}>
          {account.email === accounts[provider].live ? 'Selected' : 'Use account'}
        </button>
      </div>)}
    </div>)}
    {message && <p className="hint" role="status">{message}</p>}
    <Why>Saved Claude and Codex subscription logins. Plan names come from the saved login; they do not confirm remaining usage.</Why>
  </div>
}
