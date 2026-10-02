import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import OBR, { Item, isImage } from '@owlbear-rodeo/sdk'

import { EncounterPanel } from './EncounterPanel'

import {
  ApiClient,
  ApiError,
  AuthTokens,
  CharacterRollResponse,
  CharacterStateOut,
  GroupCharacterOut,
  GroupOut,
  MemberOut,
  UserOut,
} from './api'
import {
  API_BASE_URL,
  AUTH_STORAGE_KEY,
  CONTEXT_MENU_ASSIGN_ID,
  CONTEXT_MENU_DAMAGE_1_ID,
  CONTEXT_MENU_DAMAGE_5_ID,
  CONTEXT_MENU_HEAL_1_ID,
  CONTEXT_MENU_HEAL_5_ID,
  CONTEXT_MENU_UNLINK_ID,
  PAIRING_STORAGE_KEY,
  PENDING_TOKEN_STORAGE_KEY,
  PREFERENCES_STORAGE_KEY,
  TOKEN_LINK_METADATA_KEY,
} from './constants'

type Status = 'booting' | 'ready' | 'not-embedded'

const DND_ABILITY_KEYS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'] as const
const COMMON_DND_CONDITIONS = [
  'Blinded',
  'Charmed',
  'Deafened',
  'Frightened',
  'Grappled',
  'Incapacitated',
  'Invisible',
  'Paralyzed',
  'Poisoned',
  'Prone',
  'Restrained',
  'Stunned',
  'Unconscious',
] as const

interface TokenLinkMetadata {
  characterId: number
  characterName: string
  groupId: number
  groupName: string
  ownerUserId: number
  ownerEmail: string
  linkedAt: string
  version: number
}

interface Preferences {
  groupId: number | null
  characterId: number | null
}

interface ActiveToken {
  id: string
  name: string
}

interface LoginFormState {
  email: string
  password: string
}

interface PairingSession {
  deviceCode: string
  userCode: string
  verificationUrl: string
  intervalSeconds: number
  expiresAtIso: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStoredJson<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null
  }

  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return null
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(key, JSON.stringify(value))
}

function getStoredPendingTokenId(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage.getItem(PENDING_TOKEN_STORAGE_KEY)
}

function parseTokenLinkMetadata(raw: unknown): TokenLinkMetadata | null {
  if (!isRecord(raw)) {
    return null
  }

  const characterId = raw.characterId
  const characterName = raw.characterName
  const groupId = raw.groupId
  const groupName = raw.groupName
  const ownerUserId = raw.ownerUserId
  const ownerEmail = raw.ownerEmail
  const linkedAt = raw.linkedAt
  const version = raw.version

  if (typeof characterId !== 'number') return null
  if (typeof characterName !== 'string') return null
  if (typeof groupId !== 'number') return null
  if (typeof groupName !== 'string') return null
  if (typeof ownerUserId !== 'number') return null
  if (typeof ownerEmail !== 'string') return null
  if (typeof linkedAt !== 'string') return null
  if (typeof version !== 'number') return null

  return {
    characterId,
    characterName,
    groupId,
    groupName,
    ownerUserId,
    ownerEmail,
    linkedAt,
    version,
  }
}

function isCharacterToken(item: Item): boolean {
  return isImage(item) && item.layer === 'CHARACTER'
}

function getTokenDisplayName(item: Item): string {
  const trimmed = item.name.trim()
  if (trimmed.length > 0) {
    return trimmed
  }
  return `Token ${item.id.slice(0, 8)}`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'Unexpected error'
}

export function App() {
  const initialPreferences = readStoredJson<Preferences>(PREFERENCES_STORAGE_KEY) ?? {
    groupId: null,
    characterId: null,
  }

  const [status, setStatus] = useState<Status>(OBR.isAvailable ? 'booting' : 'not-embedded')
  const [playerName, setPlayerName] = useState<string>('Unknown')
  const [playerRole, setPlayerRole] = useState<string>('Unknown')
  const [selectionIds, setSelectionIds] = useState<string[]>([])
  const [itemsRevision, setItemsRevision] = useState<number>(0)

  const [authTokens, setAuthTokensState] = useState<AuthTokens | null>(
    readStoredJson<AuthTokens>(AUTH_STORAGE_KEY),
  )
  const authTokensRef = useRef<AuthTokens | null>(authTokens)

  const [currentUser, setCurrentUser] = useState<UserOut | null>(null)
  const [groups, setGroups] = useState<GroupOut[]>([])
  const [groupMembers, setGroupMembers] = useState<MemberOut[]>([])
  const [groupCharacters, setGroupCharacters] = useState<GroupCharacterOut[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(
    initialPreferences.groupId,
  )
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(
    initialPreferences.characterId,
  )

  const [pendingTokenId, setPendingTokenIdState] = useState<string | null>(
    getStoredPendingTokenId(),
  )
  const pendingTokenIdRef = useRef<string | null>(pendingTokenId)

  const [activeToken, setActiveToken] = useState<ActiveToken | null>(null)
  const [activeTokenLink, setActiveTokenLink] = useState<TokenLinkMetadata | null>(null)
  const [pairingSession, setPairingSessionState] = useState<PairingSession | null>(
    readStoredJson<PairingSession>(PAIRING_STORAGE_KEY),
  )

  const [loginForm, setLoginForm] = useState<LoginFormState>({ email: '', password: '' })
  const [authError, setAuthError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false)
  const [isStartingPairing, setIsStartingPairing] = useState<boolean>(false)
  const [isLoadingGroups, setIsLoadingGroups] = useState<boolean>(false)
  const [isLoadingCharacters, setIsLoadingCharacters] = useState<boolean>(false)
  const [isLinking, setIsLinking] = useState<boolean>(false)
  const [linkedCharacterState, setLinkedCharacterState] = useState<CharacterStateOut | null>(null)
  const [isLoadingState, setIsLoadingState] = useState<boolean>(false)
  const [isSavingState, setIsSavingState] = useState<boolean>(false)
  const [isRolling, setIsRolling] = useState<boolean>(false)
  const [stateError, setStateError] = useState<string | null>(null)
  const [lastRoll, setLastRoll] = useState<CharacterRollResponse | null>(null)
  const [newCondition, setNewCondition] = useState<string>('')
  const [hpCurrentInput, setHpCurrentInput] = useState<string>('')
  const [hpTempInput, setHpTempInput] = useState<string>('')

  const saveAuthTokens = useCallback((tokens: AuthTokens | null) => {
    authTokensRef.current = tokens
    setAuthTokensState(tokens)

    if (typeof window === 'undefined') {
      return
    }

    if (tokens) {
      writeStoredJson(AUTH_STORAGE_KEY, tokens)
    } else {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
    }
  }, [])

  const setPendingTokenId = useCallback((tokenId: string | null) => {
    pendingTokenIdRef.current = tokenId
    setPendingTokenIdState(tokenId)

    if (typeof window === 'undefined') {
      return
    }

    if (tokenId) {
      window.localStorage.setItem(PENDING_TOKEN_STORAGE_KEY, tokenId)
    } else {
      window.localStorage.removeItem(PENDING_TOKEN_STORAGE_KEY)
    }
  }, [])

  const savePairingSession = useCallback((nextSession: PairingSession | null) => {
    setPairingSessionState(nextSession)

    if (typeof window === 'undefined') {
      return
    }

    if (nextSession) {
      writeStoredJson(PAIRING_STORAGE_KEY, nextSession)
    } else {
      window.localStorage.removeItem(PAIRING_STORAGE_KEY)
    }
  }, [])

  const apiClient = useMemo(
    () =>
      new ApiClient({
        getTokens: () => authTokensRef.current,
        saveTokens: saveAuthTokens,
      }),
    [saveAuthTokens],
  )

  useEffect(() => {
    authTokensRef.current = authTokens
  }, [authTokens])

  useEffect(() => {
    pendingTokenIdRef.current = pendingTokenId
  }, [pendingTokenId])

  useEffect(() => {
    writeStoredJson(PREFERENCES_STORAGE_KEY, {
      groupId: selectedGroupId,
      characterId: selectedCharacterId,
    })
  }, [selectedGroupId, selectedCharacterId])

  const selectedGroup =
    selectedGroupId === null
      ? null
      : groups.find((group) => group.id === selectedGroupId) ?? null

  const currentGroupMembership =
    currentUser === null
      ? null
      : groupMembers.find((member) => member.user_id === currentUser.id) ?? null

  const currentGroupRole = currentGroupMembership?.role ?? null
  const isGroupGameMaster = currentGroupRole === 'GM' || currentGroupRole === 'CO_GM'

  const assignableGroupCharacters =
    currentUser === null
      ? []
      : isGroupGameMaster
        ? groupCharacters
        : groupCharacters.filter((assignment) => assignment.user_id === currentUser.id)

  const selectedCharacter =
    selectedCharacterId === null
      ? null
      : assignableGroupCharacters.find((assignment) => assignment.character.id === selectedCharacterId) ?? null

  const linkedAssignment =
    activeTokenLink === null
      ? null
      : groupCharacters.find(
        (assignment) =>
          assignment.character.id === activeTokenLink.characterId &&
          assignment.campaign_id === activeTokenLink.groupId,
      ) ?? null

  const linkedGameSystem = linkedCharacterState?.game_system ?? linkedAssignment?.character.game_system ?? null
  const isDndLinkedCharacter =
    linkedGameSystem === 'dnd_srd_5_1' || linkedGameSystem === 'dnd_srd_5_2_1'

  const refreshActiveToken = useCallback(async (ids: string[], pendingId: string | null) => {
    if (!OBR.isAvailable) {
      return
    }

    const uniqueIds = Array.from(new Set([...(pendingId ? [pendingId] : []), ...ids]))
    if (uniqueIds.length === 0) {
      setActiveToken(null)
      setActiveTokenLink(null)
      return
    }

    const items = await OBR.scene.items.getItems(uniqueIds)

    let candidate: Item | undefined

    if (pendingId) {
      candidate = items.find((item) => item.id === pendingId && isCharacterToken(item))
    }

    if (!candidate) {
      candidate = ids
        .map((id) => items.find((item) => item.id === id))
        .find((item): item is Item => item !== undefined && isCharacterToken(item))
    }

    if (!candidate) {
      setActiveToken(null)
      setActiveTokenLink(null)
      return
    }

    setActiveToken({
      id: candidate.id,
      name: getTokenDisplayName(candidate),
    })
    setActiveTokenLink(parseTokenLinkMetadata(candidate.metadata[TOKEN_LINK_METADATA_KEY]))
  }, [])

  const unlinkTokenById = useCallback(
    async (tokenId: string): Promise<boolean> => {
      const items = await OBR.scene.items.getItems([tokenId])
      const token = items.find((item) => item.id === tokenId && isCharacterToken(item))

      if (!token) {
        throw new Error('Selected item is not a CHARACTER-layer image token.')
      }

      const existingLink = parseTokenLinkMetadata(token.metadata[TOKEN_LINK_METADATA_KEY])
      if (!existingLink) {
        return false
      }

      await OBR.scene.items.updateItems([tokenId], (drafts) => {
        const draft = drafts[0]
        if (!draft) {
          return
        }

        const nextMetadata = { ...draft.metadata }
        delete nextMetadata[TOKEN_LINK_METADATA_KEY]
        draft.metadata = nextMetadata
      })

      if (pendingTokenIdRef.current === tokenId) {
        setPendingTokenId(null)
      }
      setItemsRevision((value) => value + 1)
      return true
    },
    [setPendingTokenId],
  )

  const applyHpDeltaToToken = useCallback(
    async (
      tokenId: string,
      delta: number,
    ): Promise<{ link: TokenLinkMetadata; before: number; after: number; maximum: number | null }> => {
      if (!authTokensRef.current) {
        throw new Error('Sign in to backend first.')
      }

      const items = await OBR.scene.items.getItems([tokenId])
      const token = items.find((item) => item.id === tokenId && isCharacterToken(item))

      if (!token) {
        throw new Error('Selected item is not a CHARACTER-layer image token.')
      }

      const link = parseTokenLinkMetadata(token.metadata[TOKEN_LINK_METADATA_KEY])
      if (!link) {
        throw new Error('Token is not linked to a character yet.')
      }

      const state = await apiClient.getCharacterState(link.characterId, link.groupId)
      if (state.hp_current === null) {
        throw new Error('HP controls are unavailable for this character.')
      }

      const before = state.hp_current
      let nextCurrent = before + delta
      nextCurrent = Math.max(0, nextCurrent)
      if (state.hp_maximum !== null) {
        nextCurrent = Math.min(state.hp_maximum, nextCurrent)
      }

      const updated = await apiClient.patchCharacterState(
        link.characterId,
        {
          hp_current: nextCurrent,
          version: state.version,
        },
        link.groupId,
      )

      setLinkedCharacterState((current) =>
        current && current.character_id === updated.character_id ? updated : current,
      )

      return {
        link,
        before,
        after: updated.hp_current ?? nextCurrent,
        maximum: updated.hp_maximum,
      }
    },
    [apiClient],
  )

  const registerContextMenus = useCallback(async () => {
    const contextMenuIds = [
      CONTEXT_MENU_ASSIGN_ID,
      CONTEXT_MENU_UNLINK_ID,
      CONTEXT_MENU_DAMAGE_1_ID,
      CONTEXT_MENU_DAMAGE_5_ID,
      CONTEXT_MENU_HEAL_1_ID,
      CONTEXT_MENU_HEAL_5_ID,
    ]
    await Promise.allSettled(contextMenuIds.map((id) => OBR.contextMenu.remove(id)))

    const characterTokenFilter = {
      min: 1,
      max: 1,
      permissions: ['UPDATE' as const],
      every: [{ key: 'layer' as const, value: 'CHARACTER' as const }],
    }

    await OBR.contextMenu.create({
      id: CONTEXT_MENU_ASSIGN_ID,
      icons: [
        {
          icon: '/icon.svg',
          label: 'Assign Character',
          filter: characterTokenFilter,
        },
      ],
      onClick: async (context, _elementId) => {
        const token = context.items.find(isCharacterToken)
        if (!token) {
          await OBR.notification.show(
            'Select exactly one CHARACTER-layer image token first.',
            'WARNING',
          )
          return
        }

        setPendingTokenId(token.id)
        await OBR.action.open()
        await OBR.notification.show(
          'Token selected. Open TTRPG Bridge to choose a group and character.',
          'INFO',
        )
      },
    })

    await OBR.contextMenu.create({
      id: CONTEXT_MENU_UNLINK_ID,
      icons: [
        {
          icon: '/icon.svg',
          label: 'Unlink Character',
          filter: characterTokenFilter,
        },
      ],
      onClick: async (context, _elementId) => {
        const token = context.items.find(isCharacterToken)
        if (!token) {
          await OBR.notification.show(
            'Select exactly one CHARACTER-layer image token first.',
            'WARNING',
          )
          return
        }

        try {
          const removed = await unlinkTokenById(token.id)
          await OBR.notification.show(
            removed ? 'Token link removed.' : 'Token is not linked.',
            removed ? 'SUCCESS' : 'INFO',
          )
        } catch (error) {
          await OBR.notification.show(getErrorMessage(error), 'ERROR')
        }
      },
    })

    const hpMenuActions = [
      { id: CONTEXT_MENU_DAMAGE_1_ID, label: 'Apply 1 Damage', delta: -1 },
      { id: CONTEXT_MENU_DAMAGE_5_ID, label: 'Apply 5 Damage', delta: -5 },
      { id: CONTEXT_MENU_HEAL_1_ID, label: 'Apply 1 Healing', delta: 1 },
      { id: CONTEXT_MENU_HEAL_5_ID, label: 'Apply 5 Healing', delta: 5 },
    ]

    for (const action of hpMenuActions) {
      await OBR.contextMenu.create({
        id: action.id,
        icons: [
          {
            icon: '/icon.svg',
            label: action.label,
            filter: characterTokenFilter,
          },
        ],
        onClick: async (context, _elementId) => {
          const token = context.items.find(isCharacterToken)
          if (!token) {
            await OBR.notification.show(
              'Select exactly one CHARACTER-layer image token first.',
              'WARNING',
            )
            return
          }

          try {
            const result = await applyHpDeltaToToken(token.id, action.delta)
            const maxText = result.maximum !== null ? `/${result.maximum}` : ''
            await OBR.notification.show(
              `${result.link.characterName}: HP ${result.before}${maxText} -> ${result.after}${maxText}`,
              'SUCCESS',
            )
          } catch (error) {
            await OBR.notification.show(getErrorMessage(error), 'ERROR')
          }
        },
      })
    }
  }, [applyHpDeltaToToken, setPendingTokenId, unlinkTokenById])

  const fetchGroups = useCallback(async () => {
    const nextGroups = await apiClient.getGroups()
    setGroups(nextGroups)
    setSelectedGroupId((current) => {
      if (current !== null && nextGroups.some((group) => group.id === current)) {
        return current
      }
      return nextGroups[0]?.id ?? null
    })
  }, [apiClient])

  useEffect(() => {
    if (!OBR.isAvailable) {
      setStatus('not-embedded')
      return
    }

    let stopPlayerSubscription: (() => void) | undefined
    let stopItemsSubscription: (() => void) | undefined
    let disposed = false

    OBR.onReady(async () => {
      if (disposed) {
        return
      }

      setStatus('ready')
      await OBR.action.setWidth(420)
      await OBR.action.setHeight(640)

      const [name, role, selection] = await Promise.all([
        OBR.player.getName(),
        OBR.player.getRole(),
        OBR.player.getSelection(),
      ])

      if (disposed) {
        return
      }

      setPlayerName(name)
      setPlayerRole(role)
      setSelectionIds(selection ?? [])

      await registerContextMenus()

      stopPlayerSubscription = OBR.player.onChange((player) => {
        setSelectionIds(player.selection ?? [])
        setPlayerRole(player.role)
      })

      stopItemsSubscription = OBR.scene.items.onChange(() => {
        setItemsRevision((value) => value + 1)
      })
    })

    return () => {
      disposed = true
      stopPlayerSubscription?.()
      stopItemsSubscription?.()

      void Promise.allSettled([
        OBR.contextMenu.remove(CONTEXT_MENU_ASSIGN_ID),
        OBR.contextMenu.remove(CONTEXT_MENU_UNLINK_ID),
        OBR.contextMenu.remove(CONTEXT_MENU_DAMAGE_1_ID),
        OBR.contextMenu.remove(CONTEXT_MENU_DAMAGE_5_ID),
        OBR.contextMenu.remove(CONTEXT_MENU_HEAL_1_ID),
        OBR.contextMenu.remove(CONTEXT_MENU_HEAL_5_ID),
      ])
    }
  }, [registerContextMenus])

  useEffect(() => {
    if (status !== 'ready') {
      return
    }

    void refreshActiveToken(selectionIds, pendingTokenId).catch((error) => {
      setLinkError(`Failed to read selected token: ${getErrorMessage(error)}`)
    })
  }, [status, selectionIds, pendingTokenId, itemsRevision, refreshActiveToken])

  useEffect(() => {
    if (!authTokens) {
      setCurrentUser(null)
      setGroups([])
      setGroupMembers([])
      setGroupCharacters([])
      return
    }

    let cancelled = false

    setIsLoadingGroups(true)
    setAuthError(null)

    const bootstrap = async () => {
      try {
        const me = await apiClient.getCurrentUser()
        if (cancelled) {
          return
        }
        setCurrentUser(me)
        await fetchGroups()
      } catch (error) {
        if (cancelled) {
          return
        }

        if (error instanceof ApiError && error.status === 401) {
          saveAuthTokens(null)
          setCurrentUser(null)
          setGroups([])
          setGroupMembers([])
          setGroupCharacters([])
          setAuthError(`Authentication failed: ${getErrorMessage(error)}`)
          return
        }

        setAuthError(`Failed to initialize extension data: ${getErrorMessage(error)}`)
      } finally {
        if (!cancelled) {
          setIsLoadingGroups(false)
        }
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
  }, [authTokens, apiClient, fetchGroups, saveAuthTokens])

  useEffect(() => {
    if (!pairingSession || authTokens) {
      return
    }

    let cancelled = false
    let pollTimerId: number | null = null

    const scheduleNextPoll = (seconds: number) => {
      pollTimerId = window.setTimeout(() => {
        void pollForApproval()
      }, Math.max(1, seconds) * 1000)
    }

    const pollForApproval = async () => {
      try {
        const response = await apiClient.pollOwlbearLink(pairingSession.deviceCode)
        if (cancelled) {
          return
        }

        if (response.status === 'pending') {
          scheduleNextPoll(response.retry_after ?? pairingSession.intervalSeconds)
          return
        }

        if (response.status === 'expired') {
          savePairingSession(null)
          setAuthError(response.detail ?? 'Pairing expired. Start a new connection.')
          return
        }

        if (!response.access_token || !response.refresh_token || !response.email) {
          savePairingSession(null)
          setAuthError('Pairing succeeded but token payload was incomplete.')
          return
        }

        saveAuthTokens({
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          email: response.email,
        })
        savePairingSession(null)
        setAuthError(null)

        if (OBR.isAvailable) {
          await OBR.notification.show('Connected via browser pairing.', 'SUCCESS')
        }
      } catch (error) {
        if (cancelled) {
          return
        }

        setAuthError(`Pairing poll failed: ${getErrorMessage(error)}`)
        scheduleNextPoll(pairingSession.intervalSeconds)
      }
    }

    void pollForApproval()

    return () => {
      cancelled = true
      if (pollTimerId !== null) {
        window.clearTimeout(pollTimerId)
      }
    }
  }, [pairingSession, authTokens, apiClient, saveAuthTokens, savePairingSession])

  useEffect(() => {
    if (!authTokens || selectedGroupId === null) {
      setGroupMembers([])
      setGroupCharacters([])
      setSelectedCharacterId(null)
      setIsLoadingCharacters(false)
      return
    }

    let cancelled = false

    setIsLoadingCharacters(true)
    setLinkError(null)

    const loadGroupCharacters = async () => {
      try {
        const [assignments, members] = await Promise.all([
          apiClient.getGroupCharacters(selectedGroupId),
          apiClient.getGroupMembers(selectedGroupId),
        ])
        if (cancelled) {
          return
        }

        setGroupMembers(members)
        setGroupCharacters(assignments)

        const membership =
          currentUser === null
            ? null
            : members.find((member) => member.user_id === currentUser.id) ?? null
        const isGameMaster = membership?.role === 'GM' || membership?.role === 'CO_GM'
        const visibleAssignments =
          currentUser === null
            ? []
            : isGameMaster
              ? assignments
              : assignments.filter((assignment) => assignment.user_id === currentUser.id)

        setSelectedCharacterId((current) => {
          if (current !== null && visibleAssignments.some((item) => item.character.id === current)) {
            return current
          }
          return visibleAssignments[0]?.character.id ?? null
        })
      } catch (error) {
        if (cancelled) {
          return
        }
        setGroupMembers([])
        setGroupCharacters([])
        setSelectedCharacterId(null)
        setLinkError(`Failed to load group characters: ${getErrorMessage(error)}`)
      } finally {
        if (!cancelled) {
          setIsLoadingCharacters(false)
        }
      }
    }

    void loadGroupCharacters()

    return () => {
      cancelled = true
    }
  }, [authTokens, apiClient, currentUser, selectedGroupId])

  useEffect(() => {
    if (!authTokens || !activeTokenLink) {
      setLinkedCharacterState(null)
      setLastRoll(null)
      setStateError(null)
      setIsLoadingState(false)
      return
    }

    let cancelled = false
    setIsLoadingState(true)
    setStateError(null)

    const loadState = async () => {
      try {
        const state = await apiClient.getCharacterState(
          activeTokenLink.characterId,
          activeTokenLink.groupId,
        )
        if (!cancelled) {
          setLinkedCharacterState(state)
        }
      } catch (error) {
        if (!cancelled) {
          setLinkedCharacterState(null)
          setStateError(`Failed to load character state: ${getErrorMessage(error)}`)
        }
      } finally {
        if (!cancelled) {
          setIsLoadingState(false)
        }
      }
    }

    void loadState()

    return () => {
      cancelled = true
    }
  }, [authTokens, activeTokenLink, apiClient])

  useEffect(() => {
    if (
      !linkedCharacterState ||
      (linkedCharacterState.hp_current === null && linkedCharacterState.hp_maximum === null)
    ) {
      setHpCurrentInput('')
      setHpTempInput('')
      return
    }

    setHpCurrentInput(
      linkedCharacterState.hp_current !== null ? String(linkedCharacterState.hp_current) : '',
    )
    setHpTempInput(String(linkedCharacterState.hp_temporary ?? 0))
  }, [linkedCharacterState])

  const patchLinkedCharacterState = useCallback(
    async (payload: { hp_current?: number; hp_temporary?: number; conditions?: string[] }) => {
      if (!activeTokenLink || !linkedCharacterState) {
        return
      }

      setIsSavingState(true)
      setStateError(null)

      try {
        const nextState = await apiClient.patchCharacterState(
          activeTokenLink.characterId,
          {
            ...payload,
            version: linkedCharacterState.version,
          },
          activeTokenLink.groupId,
        )
        setLinkedCharacterState(nextState)
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            const latest = await apiClient.getCharacterState(
              activeTokenLink.characterId,
              activeTokenLink.groupId,
            )
            setLinkedCharacterState(latest)
            setStateError('Character state changed in another client. Refreshed latest state.')
          } catch (refreshError) {
            setStateError(`State conflict and refresh failed: ${getErrorMessage(refreshError)}`)
          }
        } else {
          setStateError(`State update failed: ${getErrorMessage(error)}`)
        }
      } finally {
        setIsSavingState(false)
      }
    },
    [activeTokenLink, apiClient, linkedCharacterState],
  )

  const handleAdjustHp = (delta: number) => {
    if (!linkedCharacterState) {
      return
    }
    const current = linkedCharacterState.hp_current ?? 0
    void patchLinkedCharacterState({ hp_current: current + delta })
  }

  const handleSetHpCurrent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !linkedCharacterState ||
      (linkedCharacterState.hp_current === null && linkedCharacterState.hp_maximum === null)
    ) {
      return
    }

    const trimmed = hpCurrentInput.trim()
    if (!trimmed) {
      setStateError('Enter an HP value first.')
      return
    }

    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed)) {
      setStateError('HP must be a whole number.')
      return
    }

    let nextCurrent = Math.max(0, parsed)
    if (linkedCharacterState.hp_maximum !== null) {
      nextCurrent = Math.min(linkedCharacterState.hp_maximum, nextCurrent)
    }

    void patchLinkedCharacterState({ hp_current: nextCurrent })
  }

  const handleSetTempHp = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (
      !linkedCharacterState ||
      (linkedCharacterState.hp_current === null && linkedCharacterState.hp_maximum === null)
    ) {
      return
    }

    const trimmed = hpTempInput.trim()
    if (!trimmed) {
      setStateError('Enter a temp HP value first.')
      return
    }

    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed)) {
      setStateError('Temp HP must be a whole number.')
      return
    }

    const nextTemp = Math.max(0, parsed)
    void patchLinkedCharacterState({ hp_temporary: nextTemp })
  }

  const handleAdjustTempHp = (delta: number) => {
    if (!linkedCharacterState) {
      return
    }
    const current = linkedCharacterState.hp_temporary ?? 0
    const next = Math.max(0, current + delta)
    void patchLinkedCharacterState({ hp_temporary: next })
  }

  const handleToggleCondition = (conditionName: string) => {
    if (!linkedCharacterState) {
      return
    }
    const current = linkedCharacterState.conditions
    const exists = current.some((item) => item.toLowerCase() === conditionName.toLowerCase())
    const next = exists
      ? current.filter((item) => item.toLowerCase() !== conditionName.toLowerCase())
      : [...current, conditionName]
    void patchLinkedCharacterState({ conditions: next })
  }

  const handleAddCondition = () => {
    if (!linkedCharacterState) {
      return
    }
    const next = newCondition.trim()
    if (!next) {
      return
    }
    setNewCondition('')
    void patchLinkedCharacterState({ conditions: [...linkedCharacterState.conditions, next] })
  }

  const handleRoll = async (rollType: 'ability' | 'skill' | 'custom', key: string) => {
    if (!activeTokenLink) {
      return
    }

    setIsRolling(true)
    setStateError(null)

    try {
      const response = await apiClient.rollCharacter(
        activeTokenLink.characterId,
        {
          type: rollType,
          key,
        },
        activeTokenLink.groupId,
      )
      setLastRoll(response)
    } catch (error) {
      setStateError(`Roll failed: ${getErrorMessage(error)}`)
    } finally {
      setIsRolling(false)
    }
  }

  const handleStartPairing = async () => {
    setAuthError(null)
    setIsStartingPairing(true)

    try {
      const response = await apiClient.startOwlbearLink()
      const nextSession: PairingSession = {
        deviceCode: response.device_code,
        userCode: response.user_code,
        verificationUrl: response.verification_url,
        intervalSeconds: response.interval,
        expiresAtIso: new Date(Date.now() + response.expires_in * 1000).toISOString(),
      }

      savePairingSession(nextSession)
      window.open(nextSession.verificationUrl, '_blank', 'noopener,noreferrer')

      if (OBR.isAvailable) {
        await OBR.notification.show('Browser pairing started. Approve the code in your browser.', 'INFO')
      }
    } catch (error) {
      setAuthError(`Could not start pairing: ${getErrorMessage(error)}`)
    } finally {
      setIsStartingPairing(false)
    }
  }

  const handleOpenPairingPage = () => {
    if (!pairingSession) {
      return
    }
    window.open(pairingSession.verificationUrl, '_blank', 'noopener,noreferrer')
  }

  const handleCancelPairing = () => {
    savePairingSession(null)
  }

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setAuthError(null)
    setIsAuthenticating(true)

    try {
      const response = await apiClient.login(loginForm.email.trim(), loginForm.password)

      if (response.mfa_required) {
        throw new Error('MFA-enabled accounts are not supported by this extension yet.')
      }

      if (!response.access_token || !response.refresh_token || !response.email) {
        throw new Error('Login response did not include all expected auth fields.')
      }

      saveAuthTokens({
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        email: response.email,
      })

      setLoginForm((current) => ({ ...current, password: '' }))

      if (OBR.isAvailable) {
        await OBR.notification.show('Signed in to backend API.', 'SUCCESS')
      }
    } catch (error) {
      setAuthError(getErrorMessage(error))
    } finally {
      setIsAuthenticating(false)
    }
  }

  const handleLogout = () => {
    saveAuthTokens(null)
    savePairingSession(null)
    setCurrentUser(null)
    setGroups([])
    setGroupMembers([])
    setGroupCharacters([])
    setSelectedGroupId(null)
    setSelectedCharacterId(null)
    setAuthError(null)
  }

  const handleRefreshGroups = async () => {
    if (!authTokensRef.current) {
      return
    }

    setIsLoadingGroups(true)
    setAuthError(null)

    try {
      await fetchGroups()
    } catch (error) {
      setAuthError(`Failed to load groups: ${getErrorMessage(error)}`)
    } finally {
      setIsLoadingGroups(false)
    }
  }

  const handleLinkActiveToken = async () => {
    if (!OBR.isAvailable) {
      return
    }
    if (!activeToken) {
      setLinkError('Select a CHARACTER-layer image token before linking.')
      return
    }
    if (!currentUser) {
      setLinkError('Sign in before linking a token.')
      return
    }
    if (!selectedGroup || !selectedCharacter) {
      setLinkError('Choose a group and character first.')
      return
    }

    const metadata: TokenLinkMetadata = {
      characterId: selectedCharacter.character.id,
      characterName: selectedCharacter.character.name,
      groupId: selectedGroup.id,
      groupName: selectedGroup.name,
      ownerUserId: currentUser.id,
      ownerEmail: currentUser.email,
      linkedAt: new Date().toISOString(),
      version: 1,
    }

    setIsLinking(true)
    setLinkError(null)

    try {
      await OBR.scene.items.updateItems([activeToken.id], (drafts) => {
        const draft = drafts[0]
        if (!draft) {
          return
        }

        draft.metadata = {
          ...draft.metadata,
          [TOKEN_LINK_METADATA_KEY]: metadata,
        }
      })

      setActiveTokenLink(metadata)
      if (pendingTokenIdRef.current === activeToken.id) {
        setPendingTokenId(null)
      }
      setItemsRevision((value) => value + 1)
      await OBR.notification.show(
        `Linked ${selectedCharacter.character.name} to ${activeToken.name}.`,
        'SUCCESS',
      )
    } catch (error) {
      const message = `Link failed: ${getErrorMessage(error)}`
      setLinkError(message)
      await OBR.notification.show(message, 'ERROR')
    } finally {
      setIsLinking(false)
    }
  }

  const handleUnlinkActiveToken = async () => {
    if (!OBR.isAvailable || !activeToken) {
      setLinkError('No active token selected to unlink.')
      return
    }

    setIsLinking(true)
    setLinkError(null)

    try {
      const removed = await unlinkTokenById(activeToken.id)
      setActiveTokenLink(null)
      await OBR.notification.show(
        removed ? 'Token link removed.' : 'Token is not linked.',
        removed ? 'SUCCESS' : 'INFO',
      )
    } catch (error) {
      const message = `Unlink failed: ${getErrorMessage(error)}`
      setLinkError(message)
      await OBR.notification.show(message, 'ERROR')
    } finally {
      setIsLinking(false)
    }
  }

  const pendingTokenNotice =
    pendingTokenId && activeToken
      ? `Pending assignment token: ${activeToken.name}`
      : pendingTokenId
        ? `Pending assignment token id: ${pendingTokenId}`
        : null

  if (status === 'not-embedded') {
    return (
      <main className="app-shell">
        <h1>TTRPG Owlbear Bridge</h1>
        <p>This page is intended to run inside Owlbear Rodeo.</p>
        <p>Load the extension manifest URL in Owlbear to continue.</p>
        <p className="muted">API base URL: {API_BASE_URL}</p>
      </main>
    )
  }

  if (status === 'booting') {
    return (
      <main className="app-shell">
        <h1>TTRPG Owlbear Bridge</h1>
        <p>Waiting for Owlbear SDK...</p>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header>
        <h1>TTRPG Owlbear Bridge</h1>
        <p className="muted">Step 3 runtime: auth + token linking + quick controls.</p>
      </header>

      <section className="card">
        <h2>SDK Status</h2>
        <ul>
          <li>Embedded in Owlbear: Yes</li>
          <li>SDK Ready: Yes</li>
          <li>Player role: {playerRole}</li>
          <li>Player name: {playerName}</li>
          <li>Selected items: {selectionIds.length}</li>
        </ul>
      </section>

      {authTokens && selectedGroupId !== null && (
        <EncounterPanel apiClient={apiClient} campaignId={selectedGroupId} />
      )}

      <section className="card">
        <h2>Backend Auth</h2>
        {!authTokens ? (
          <div className="stack">
            <button type="button" onClick={handleStartPairing} disabled={isStartingPairing}>
              {isStartingPairing
                ? 'Starting pairing...'
                : pairingSession
                  ? 'Restart browser pairing'
                  : 'Connect via browser (recommended)'}
            </button>

            {pairingSession ? (
              <div className="info-box">
                <p>
                  Pairing code: <strong>{pairingSession.userCode}</strong>
                </p>
                <p className="muted">
                  Open the verification page in your normal browser and approve this code while signed in.
                </p>
                <p className="muted">Expires at: {new Date(pairingSession.expiresAtIso).toLocaleString()}</p>
                <div className="button-row">
                  <button type="button" onClick={handleOpenPairingPage}>
                    Open verification page
                  </button>
                  <button type="button" className="secondary" onClick={handleCancelPairing}>
                    Cancel pairing
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">No active pairing session.</p>
            )}

            <p className="muted">Fallback: sign in directly with email and password.</p>

            <form className="stack" onSubmit={handleLogin}>
              <label className="stack">
                <span>Email</span>
                <input
                  type="email"
                  value={loginForm.email}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, email: event.target.value }))
                  }
                  required
                />
              </label>

              <label className="stack">
                <span>Password</span>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, password: event.target.value }))
                  }
                  required
                />
              </label>

              <button type="submit" disabled={isAuthenticating}>
                {isAuthenticating ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          </div>
        ) : (
          <div className="stack">
            <p>
              Signed in as <strong>{currentUser?.username ?? currentUser?.email ?? authTokens.email}</strong>
            </p>
            <div className="button-row">
              <button type="button" onClick={handleRefreshGroups} disabled={isLoadingGroups}>
                {isLoadingGroups ? 'Refreshing groups...' : 'Refresh groups'}
              </button>
              <button type="button" className="secondary" onClick={handleLogout}>
                Sign out
              </button>
            </div>
          </div>
        )}

        <p className="muted">API base URL: {API_BASE_URL}</p>
        {authError ? <p className="error">{authError}</p> : null}
      </section>

      <section className="card">
        <h2>Token Linking</h2>
        <p>
          Active token:{' '}
          <strong>{activeToken ? `${activeToken.name} (${activeToken.id})` : 'No token selected'}</strong>
        </p>
        {pendingTokenNotice ? <p className="muted">{pendingTokenNotice}</p> : null}

        {activeTokenLink ? (
          <div className="info-box">
            <p>
              Linked to <strong>{activeTokenLink.characterName}</strong> in{' '}
              <strong>{activeTokenLink.groupName}</strong>
            </p>
            <p className="muted">Last linked at: {new Date(activeTokenLink.linkedAt).toLocaleString()}</p>
          </div>
        ) : (
          <p className="muted">This token is currently not linked.</p>
        )}

        <label className="stack">
          <span>Group</span>
          <select
            value={selectedGroupId ?? ''}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              setSelectedGroupId(Number.isNaN(parsed) ? null : parsed)
            }}
            disabled={!authTokens || groups.length === 0 || isLoadingGroups}
          >
            <option value="">Select group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>

        <label className="stack">
          <span>Character</span>
          <select
            value={selectedCharacterId ?? ''}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10)
              setSelectedCharacterId(Number.isNaN(parsed) ? null : parsed)
            }}
            disabled={!authTokens || selectedGroupId === null || isLoadingCharacters}
          >
            <option value="">Select character</option>
            {assignableGroupCharacters.map((assignment) => (
              <option key={assignment.id} value={assignment.character.id}>
                {assignment.character.name}
              </option>
            ))}
          </select>
        </label>

        {authTokens && selectedGroupId !== null ? (
          <p className="muted">
            {isLoadingCharacters
              ? 'Loading group roles and characters...'
              : currentGroupMembership === null
                ? 'You are not an active member of this group.'
                : isGroupGameMaster
                  ? 'GM/CO-GM: you can link tokens to any character assigned in this group.'
                  : 'Player: you can link tokens only to characters assigned to your account in this group.'}
          </p>
        ) : null}

        <div className="button-row">
          <button
            type="button"
            onClick={handleLinkActiveToken}
            disabled={isLinking || !authTokens || !activeToken}
          >
            {isLinking ? 'Applying...' : 'Link token'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={handleUnlinkActiveToken}
            disabled={isLinking || !activeToken}
          >
            Unlink token
          </button>
          <button type="button" className="secondary" onClick={() => setPendingTokenId(null)}>
            Clear pending token
          </button>
        </div>

        <p className="muted">
          Context menu actions available on CHARACTER tokens: <strong>Assign Character</strong>,{' '}
          <strong>Unlink Character</strong>, <strong>Apply 1/5 Damage</strong>, and{' '}
          <strong>Apply 1/5 Healing</strong>.
        </p>
        {linkError ? <p className="error">{linkError}</p> : null}
      </section>

      <section className="card">
        <h2>Quick Controls</h2>

        {!authTokens ? <p className="muted">Sign in to use quick controls.</p> : null}

        {authTokens && !activeTokenLink ? (
          <p className="muted">Link a token to a character first.</p>
        ) : null}

        {authTokens && activeTokenLink && isLoadingState ? (
          <p className="muted">Loading linked character state...</p>
        ) : null}

        {authTokens && activeTokenLink && linkedCharacterState ? (
          <>
            <div className="info-box">
              <p>
                Linked character: <strong>{activeTokenLink.characterName}</strong>
              </p>
              <p className="muted">
                Group: <strong>{activeTokenLink.groupName}</strong>
              </p>
              <p className="muted">
                System: <strong>{linkedGameSystem ?? 'unknown'}</strong>
              </p>
              <p className="muted">State version: {linkedCharacterState.version}</p>
            </div>

            {linkedCharacterState.hp_current !== null || linkedCharacterState.hp_maximum !== null ? (
              <div className="stack">
                <p>
                  HP: <strong>{linkedCharacterState.hp_current ?? '-'}</strong> /{' '}
                  <strong>{linkedCharacterState.hp_maximum ?? '-'}</strong>
                  {'  '}
                  Temp: <strong>{linkedCharacterState.hp_temporary ?? 0}</strong>
                </p>
                <div className="inline-input-two-columns">
                  <form className="inline-input-row" onSubmit={handleSetHpCurrent}>
                    <input
                      type="number"
                      min={0}
                      max={linkedCharacterState.hp_maximum ?? undefined}
                      step={1}
                      value={hpCurrentInput}
                      onChange={(event) => setHpCurrentInput(event.target.value)}
                      disabled={isSavingState}
                      placeholder="Set exact current HP"
                    />
                    <button
                      type="submit"
                      disabled={isSavingState || hpCurrentInput.trim().length === 0}
                    >
                      Set HP
                    </button>
                  </form>

                  <form className="inline-input-row" onSubmit={handleSetTempHp}>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={hpTempInput}
                      onChange={(event) => setHpTempInput(event.target.value)}
                      disabled={isSavingState}
                      placeholder="Set exact temp HP"
                    />
                    <button
                      type="submit"
                      disabled={isSavingState || hpTempInput.trim().length === 0}
                    >
                      Set Temp
                    </button>
                  </form>
                </div>
                <div className="button-row">
                  <button type="button" onClick={() => handleAdjustHp(-1)} disabled={isSavingState}>
                    -1 HP
                  </button>
                  <button type="button" onClick={() => handleAdjustHp(1)} disabled={isSavingState}>
                    +1 HP
                  </button>
                  <button type="button" onClick={() => handleAdjustHp(-5)} disabled={isSavingState}>
                    -5 HP
                  </button>
                  <button type="button" onClick={() => handleAdjustHp(5)} disabled={isSavingState}>
                    +5 HP
                  </button>
                </div>
                <div className="button-row">
                  <button type="button" className="secondary" onClick={() => handleAdjustTempHp(-1)} disabled={isSavingState}>
                    -1 Temp
                  </button>
                  <button type="button" className="secondary" onClick={() => handleAdjustTempHp(1)} disabled={isSavingState}>
                    +1 Temp
                  </button>
                  <button type="button" className="secondary" onClick={() => handleAdjustTempHp(5)} disabled={isSavingState}>
                    +5 Temp
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">HP controls are unavailable for this character system.</p>
            )}

            <div className="stack">
              <p>Conditions</p>
              {isDndLinkedCharacter ? (
                <div className="chip-row">
                  {COMMON_DND_CONDITIONS.map((condition) => {
                    const active = linkedCharacterState.conditions.some(
                      (value) => value.toLowerCase() === condition.toLowerCase(),
                    )
                    return (
                      <button
                        key={condition}
                        type="button"
                        className={active ? 'secondary condition-active' : 'secondary'}
                        onClick={() => handleToggleCondition(condition)}
                        disabled={isSavingState}
                      >
                        {condition}
                      </button>
                    )
                  })}
                </div>
              ) : null}

              <div className="chip-row">
                {linkedCharacterState.conditions.map((condition) => (
                  <button
                    key={`active-${condition}`}
                    type="button"
                    className="secondary condition-active"
                    onClick={() => handleToggleCondition(condition)}
                    disabled={isSavingState}
                  >
                    {condition} x
                  </button>
                ))}
              </div>

              <div className="inline-input-row">
                <input
                  type="text"
                  placeholder="Add custom condition"
                  value={newCondition}
                  onChange={(event) => setNewCondition(event.target.value)}
                  disabled={isSavingState}
                />
                <button type="button" onClick={handleAddCondition} disabled={isSavingState || newCondition.trim().length === 0}>
                  Add
                </button>
              </div>
            </div>

            <div className="stack">
              <p>Rolls</p>
              <div className="button-row">
                {isDndLinkedCharacter
                  ? DND_ABILITY_KEYS.map((ability) => (
                    <button
                      key={ability}
                      type="button"
                      className="secondary"
                      onClick={() => {
                        void handleRoll('ability', ability)
                      }}
                      disabled={isRolling}
                    >
                      {ability.slice(0, 3).toUpperCase()}
                    </button>
                  ))
                  : null}

                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void handleRoll('skill', 'perception')
                  }}
                  disabled={isRolling}
                >
                  Perception
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void handleRoll('skill', 'stealth')
                  }}
                  disabled={isRolling}
                >
                  Stealth
                </button>
              </div>

              {lastRoll ? (
                <div className="info-box">
                  <p>
                    Last roll: <strong>{lastRoll.total}</strong>
                  </p>
                  <p className="muted">{lastRoll.breakdown}</p>
                </div>
              ) : (
                <p className="muted">No roll yet.</p>
              )}
            </div>
          </>
        ) : null}

        {stateError ? <p className="error">{stateError}</p> : null}
      </section>
    </main>
  )
}
