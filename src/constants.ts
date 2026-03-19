export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8000'

export const TOKEN_LINK_METADATA_KEY =
  'com.university-final-project.ttrpg/token-link'

export const CONTEXT_MENU_ASSIGN_ID =
  'com.university-final-project.ttrpg.assign-character'

export const CONTEXT_MENU_UNLINK_ID =
  'com.university-final-project.ttrpg.unlink-character'

export const CONTEXT_MENU_DAMAGE_1_ID =
  'com.university-final-project.ttrpg.damage-1'

export const CONTEXT_MENU_DAMAGE_5_ID =
  'com.university-final-project.ttrpg.damage-5'

export const CONTEXT_MENU_HEAL_1_ID =
  'com.university-final-project.ttrpg.heal-1'

export const CONTEXT_MENU_HEAL_5_ID =
  'com.university-final-project.ttrpg.heal-5'

export const AUTH_STORAGE_KEY = 'ttrpg-owlbear-auth-v1'
export const PREFERENCES_STORAGE_KEY = 'ttrpg-owlbear-preferences-v1'
export const PENDING_TOKEN_STORAGE_KEY = 'ttrpg-owlbear-pending-token-id-v1'
export const PAIRING_STORAGE_KEY = 'ttrpg-owlbear-pairing-v1'
