import { useEffect, useState } from 'react'

import type { ActiveEncounterOut, ApiClient } from './api'

/** The campaign's running encounter — initiative order, current turn, HP as
 * numbers for PCs and a word for monsters — refreshed every few seconds so the
 * table can keep it open beside the map (phase 11 of the Mancer campaigns plan). */
export function EncounterPanel({ apiClient, campaignId }: { apiClient: ApiClient; campaignId: number }) {
  const [encounter, setEncounter] = useState<ActiveEncounterOut | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = await apiClient.getActiveEncounter(campaignId)
        if (!cancelled) setEncounter(next)
      } catch {
        if (!cancelled) setEncounter(null)
      }
    }
    void load()
    const timer = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [apiClient, campaignId])

  if (!encounter) return null
  return (
    <section className="card">
      <h2>
        {encounter.name} <span className="muted">· round {encounter.round}</span>
      </h2>
      <ol>
        {encounter.combatants.map((c) => (
          <li
            key={c.id}
            style={{
              fontWeight: c.id === encounter.current_combatant_id ? 700 : 400,
              textDecoration: c.defeated ? 'line-through' : undefined,
            }}
          >
            {c.initiative ?? '–'} · {c.name}
            {c.hp_current !== null
              ? ` · ${c.hp_current}${c.hp_max !== null ? `/${c.hp_max}` : ''} HP`
              : c.hp_state
                ? ` · ${c.hp_state}`
                : ''}
            {c.conditions.length > 0 ? ` · ${c.conditions.join(', ')}` : ''}
          </li>
        ))}
      </ol>
    </section>
  )
}
