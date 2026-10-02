import { API_BASE_URL } from './constants'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  email: string
}

export interface LoginResponse {
  mfa_required: boolean
  access_token: string | null
  refresh_token: string | null
  token_type: string
  email: string | null
  mfa_token: string | null
  mfa_method: string | null
}

export interface RefreshResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface UserOut {
  id: number
  email: string
  username: string | null
  full_name: string | null
  is_verified: boolean
  has_password: boolean
  created_at: string
}

export interface GroupOut {
  id: number
  name: string
  game_system: string | null
  description: string | null
  campaign_notes: string | null
  created_by_user_id: number
  created_at: string
}

export interface MemberOut {
  user_id: number
  email: string
  username: string | null
  role: 'GM' | 'CO_GM' | 'PLAYER'
  status: 'ACTIVE' | 'LEFT' | 'REMOVED'
  created_at: string
}

export interface CharacterListOut {
  id: number
  name: string
  game_system: string
  created_at: string
  character_data?: Record<string, unknown> | null
}

export interface GroupCharacterOut {
  id: number
  campaign_id: number
  character_id: number
  user_id: number
  is_active: boolean
  joined_at: string
  character: CharacterListOut
}

export interface EncounterCombatantOut {
  id: number
  name: string
  kind: 'pc' | 'monster' | 'npc'
  initiative: number | null
  hp_current: number | null
  hp_max: number | null
  hp_state: string | null
  conditions: string[]
  defeated: boolean
}

export interface ActiveEncounterOut {
  id: number
  name: string
  round: number
  current_combatant_id: number | null
  combatants: EncounterCombatantOut[]
}

export interface CharacterStateOut {
  character_id: number
  game_system: string
  hp_current: number | null
  hp_maximum: number | null
  hp_temporary: number | null
  conditions: string[]
  updated_at: string
  version: number
}

export interface CharacterStatePatchRequest {
  hp_current?: number
  hp_temporary?: number
  conditions?: string[]
  version?: number
}

export interface CharacterRollRequest {
  type: 'ability' | 'skill' | 'custom'
  key: string
  advantage?: boolean
  disadvantage?: boolean
  modifier?: number
}

export interface CharacterRollResponse {
  character_id: number
  game_system: string
  type: string
  key: string
  dice: number[]
  roll_total: number
  modifier: number
  total: number
  breakdown: string
  rolled_at: string
}

export interface OwlbearLinkStartResponse {
  device_code: string
  user_code: string
  verification_url: string
  expires_in: number
  interval: number
}

export interface OwlbearLinkTokenResponse {
  status: 'pending' | 'expired' | 'approved'
  access_token: string | null
  refresh_token: string | null
  token_type: string
  email: string | null
  retry_after: number | null
  detail: string | null
}

export class ApiError extends Error {
  status: number

  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
    this.name = 'ApiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function extractErrorDetail(payload: unknown): string {
  if (typeof payload === 'string') return payload

  if (isRecord(payload)) {
    const detail = payload.detail
    if (typeof detail === 'string') return detail

    if (isRecord(detail)) {
      const message = detail.message
      if (typeof message === 'string') return message
      return JSON.stringify(detail)
    }

    if (Array.isArray(detail)) {
      return detail
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .join('; ')
    }
  }

  return 'Request failed'
}

interface ApiClientOptions {
  getTokens: () => AuthTokens | null
  saveTokens: (tokens: AuthTokens | null) => void
}

export class ApiClient {
  private getTokens: () => AuthTokens | null
  private saveTokens: (tokens: AuthTokens | null) => void
  private refreshInFlight: Promise<AuthTokens> | null = null

  constructor(options: ApiClientOptions) {
    this.getTokens = options.getTokens
    this.saveTokens = options.saveTokens
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      auth: false,
      body: { email, password },
    })
  }

  async getCurrentUser(): Promise<UserOut> {
    return this.request<UserOut>('/auth/me', { method: 'GET' })
  }

  async getGroups(): Promise<GroupOut[]> {
    return this.request<GroupOut[]>('/campaigns', { method: 'GET' })
  }

  async getActiveEncounter(campaignId: number): Promise<ActiveEncounterOut | null> {
    return this.request<ActiveEncounterOut | null>(`/campaigns/${campaignId}/encounters/active`, {
      method: 'GET',
    })
  }

  async getGroupCharacters(groupId: number): Promise<GroupCharacterOut[]> {
    return this.request<GroupCharacterOut[]>(`/campaigns/${groupId}/characters`, {
      method: 'GET',
    })
  }

  async getGroupMembers(groupId: number): Promise<MemberOut[]> {
    return this.request<MemberOut[]>(`/campaigns/${groupId}/members`, {
      method: 'GET',
    })
  }

  async getCharacterState(characterId: number, groupId?: number): Promise<CharacterStateOut> {
    return this.request<CharacterStateOut>(this.withGroupQuery(`/characters/${characterId}/state`, groupId), {
      method: 'GET',
    })
  }

  async patchCharacterState(
    characterId: number,
    payload: CharacterStatePatchRequest,
    groupId?: number,
  ): Promise<CharacterStateOut> {
    return this.request<CharacterStateOut>(this.withGroupQuery(`/characters/${characterId}/state`, groupId), {
      method: 'PATCH',
      body: payload as unknown as Record<string, unknown>,
    })
  }

  async rollCharacter(
    characterId: number,
    payload: CharacterRollRequest,
    groupId?: number,
  ): Promise<CharacterRollResponse> {
    return this.request<CharacterRollResponse>(this.withGroupQuery(`/characters/${characterId}/roll`, groupId), {
      method: 'POST',
      body: { ...payload, ...(groupId !== undefined ? { campaign_id: groupId } : {}) } as unknown as Record<string, unknown>,
    })
  }

  async startOwlbearLink(): Promise<OwlbearLinkStartResponse> {
    return this.request<OwlbearLinkStartResponse>('/integrations/owlbear/link/start', {
      method: 'POST',
      auth: false,
      body: {},
    })
  }

  async pollOwlbearLink(deviceCode: string): Promise<OwlbearLinkTokenResponse> {
    return this.request<OwlbearLinkTokenResponse>('/integrations/owlbear/link/token', {
      method: 'POST',
      auth: false,
      body: { device_code: deviceCode },
    })
  }

  private async request<T>(
    path: string,
    options: {
      method: string
      auth?: boolean
      body?: Record<string, unknown>
    },
  ): Promise<T> {
    const authEnabled = options.auth ?? true
    const tokens = this.getTokens()

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (authEnabled && tokens?.accessToken) {
      headers.Authorization = `Bearer ${tokens.accessToken}`
    }

    const runFetch = () =>
      fetch(`${API_BASE_URL}${path}`, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      })

    let response = await runFetch()

    if (response.status === 401 && authEnabled && tokens?.refreshToken) {
      const refreshed = await this.refreshTokens(tokens)
      headers.Authorization = `Bearer ${refreshed.accessToken}`
      response = await runFetch()
    }

    if (!response.ok) {
      throw await this.toApiError(response)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  private async refreshTokens(current: AuthTokens): Promise<AuthTokens> {
    if (this.refreshInFlight) {
      return this.refreshInFlight
    }

    this.refreshInFlight = (async () => {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
      })

      if (!response.ok) {
        this.saveTokens(null)
        throw await this.toApiError(response)
      }

      const payload = (await response.json()) as RefreshResponse
      const nextTokens: AuthTokens = {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        email: current.email,
      }
      this.saveTokens(nextTokens)
      return nextTokens
    })()

    try {
      return await this.refreshInFlight
    } finally {
      this.refreshInFlight = null
    }
  }

  private withGroupQuery(path: string, groupId?: number): string {
    if (groupId === undefined) {
      return path
    }
    const params = new URLSearchParams({ campaign_id: String(groupId) })
    return `${path}?${params.toString()}`
  }

  private async toApiError(response: Response): Promise<ApiError> {
    try {
      const payload = await response.json()
      return new ApiError(response.status, extractErrorDetail(payload))
    } catch {
      return new ApiError(response.status, `Request failed with status ${response.status}`)
    }
  }
}
