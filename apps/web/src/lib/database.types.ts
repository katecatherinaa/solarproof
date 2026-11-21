export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      cooperatives: {
        Row: { id: string; name: string; admin_address: string; created_at: string; suspended: boolean; account_type: 'individual' | 'cooperative'; evm_nft_enabled: boolean }
        Insert: { name: string; admin_address: string; suspended?: boolean; account_type?: 'individual' | 'cooperative'; evm_nft_enabled?: boolean }
        Update: Partial<{ name: string; admin_address: string; suspended: boolean; account_type: 'individual' | 'cooperative'; evm_nft_enabled: boolean }>
        Relationships: []
      }
      proposals: {
        Row: {
          id: string; cooperative_id: string; title: string; description: string
          status: 'active' | 'passed' | 'rejected'; action: string | null; ends_at: string; created_at: string
        }
        Insert: {
          cooperative_id: string; title: string; description: string
          status?: 'active' | 'passed' | 'rejected'; action?: string | null; ends_at: string
        }
        Update: Partial<{
          title: string; description: string; status: 'active' | 'passed' | 'rejected'; action: string | null; ends_at: string
        }>
        Relationships: []
      }
      votes: {
        Row: { proposal_id: string; voter_id: string; choice: 'for' | 'against' | 'abstain'; created_at: string }
        Insert: { proposal_id: string; voter_id: string; choice: 'for' | 'against' | 'abstain' }
        Update: Partial<{ choice: 'for' | 'against' | 'abstain' }>
        Relationships: []
      }
      meters: {
        Row: {
          id: string; cooperative_id: string; serial_number: string
          name: string; pubkey_hex: string; active: boolean; created_at: string
          api_key: string; meter_group: string | null; tags: string[]
          revoked_at: string | null; revocation_reason: string | null
        }
        Insert: {
          cooperative_id: string; serial_number: string; name: string; pubkey_hex: string
          active: boolean; api_key?: string; meter_group?: string | null; tags?: string[]
          revoked_at?: string | null; revocation_reason?: string | null
        }
        Update: Partial<{
          cooperative_id: string; serial_number: string; name: string; pubkey_hex: string
          active: boolean; api_key: string; meter_group: string | null; tags: string[]
          revoked_at: string | null; revocation_reason: string | null
        }>
        Relationships: []
      }
      readings: {
        Row: {
          id: string; meter_id: string; kwh: number; timestamp: string
          reading_hash: string; signature_hex: string
          anchor_tx_hash: string | null; mint_tx_hash: string | null
          anchored: boolean; minted: boolean
          mint_diagnosis: Json | null
        }
        Insert: {
          meter_id: string; kwh: number; timestamp: string
          reading_hash: string; signature_hex: string
          anchor_tx_hash?: string | null; mint_tx_hash?: string | null
          anchored: boolean; minted: boolean
          mint_diagnosis?: Json | null
        }
        Update: Partial<{
          meter_id: string; kwh: number; timestamp: string
          reading_hash: string; signature_hex: string
          anchor_tx_hash: string | null; mint_tx_hash: string | null
          anchored: boolean; minted: boolean
          mint_diagnosis: Json | null
        }>
        Relationships: [{ foreignKeyName: 'readings_meter_id_fkey'; columns: ['meter_id']; referencedRelation: 'meters'; referencedColumns: ['id'] }]
      }
      idempotency_keys: {
        Row: { nonce: string; reading_id: string; response: Json; created_at: string }
        Insert: Omit<Database['public']['Tables']['idempotency_keys']['Row'], 'created_at'>
        Update: Partial<Database['public']['Tables']['idempotency_keys']['Insert']>
        Relationships: []
      }
      certificates: {
        Row: {
          id: string; cooperative_id: string; reading_id: string
          reading_hash: string; mint_tx_hash: string; anchor_tx_hash: string
          kwh: number; issued_at: string; retired: boolean
          retired_at: string | null; retired_by: string | null
          retire_tx_hash: string | null
          expires_at: string | null
          erc1888_token_id: string | null
          erc1888_issuance_status: 'pending' | 'issued' | 'failed' | null
          erc1888_tx_hash: string | null
          erc1888_issued_at: string | null
          evm_token_id: string | null
          evm_tx_hash: string | null
          evm_issuance_status: 'pending' | 'issued' | 'failed' | null
          evm_issued_at: string | null
        }
        Insert: {
          cooperative_id: string; reading_id: string
          reading_hash: string; mint_tx_hash: string; anchor_tx_hash: string
          kwh: number; issued_at: string; retired: boolean
          retired_at?: string | null; retired_by?: string | null
          expires_at?: string | null
          erc1888_token_id?: string | null
          erc1888_issuance_status?: 'pending' | 'issued' | 'failed' | null
          erc1888_tx_hash?: string | null
          erc1888_issued_at?: string | null
          evm_token_id?: string | null
          evm_tx_hash?: string | null
          evm_issuance_status?: 'pending' | 'issued' | 'failed' | null
          evm_issued_at?: string | null
        }
        Update: Partial<{
          cooperative_id: string; reading_id: string
          reading_hash: string; mint_tx_hash: string; anchor_tx_hash: string
          kwh: number; issued_at: string; retired: boolean
          retired_at: string | null; retired_by: string | null
          retire_tx_hash: string | null
          expires_at: string | null
          erc1888_token_id: string | null
          erc1888_issuance_status: 'pending' | 'issued' | 'failed' | null
          erc1888_tx_hash: string | null
          erc1888_issued_at: string | null
          evm_token_id: string | null
          evm_tx_hash: string | null
          evm_issuance_status: 'pending' | 'issued' | 'failed' | null
          evm_issued_at: string | null
        }>
        Relationships: [{ foreignKeyName: 'certificates_reading_id_fkey'; columns: ['reading_id']; referencedRelation: 'readings'; referencedColumns: ['id'] }]
      }
      webhook_endpoints: {
        Row: {
          id: string; cooperative_id: string; url: string; secret: string
          events: string[]; active: boolean; created_at: string
        }
        Insert: { cooperative_id: string; url: string; secret: string; events: string[]; active?: boolean }
        Update: Partial<Database['public']['Tables']['webhook_endpoints']['Insert']>
        Relationships: []
      }
      webhook_logs: {
        Row: {
          id: string; endpoint_id: string; event: string; payload: Json
          status: string; attempts: number; response_status: number | null; created_at: string
        }
        Insert: Omit<Database['public']['Tables']['webhook_logs']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['webhook_logs']['Insert']>
        Relationships: []
      }
      audit_logs: {
        Row: {
          id: string; timestamp: string; actor: string; action: string
          resource: string; resource_id: string | null; ip: string | null; metadata: Json | null
        }
        Insert: Omit<Database['public']['Tables']['audit_logs']['Row'], 'id' | 'timestamp'>
        Update: Partial<Database['public']['Tables']['audit_logs']['Insert']>
        Relationships: []
      }
      retirement_events: {
        Row: {
          id: string; certificate_id: string; beneficiary: string
          retire_tx_hash: string; kwh: number; retired_at: string
        }
        Insert: Omit<Database['public']['Tables']['retirement_events']['Row'], 'id' | 'retired_at'>
        Update: Partial<Database['public']['Tables']['retirement_events']['Insert']>
        Relationships: []
      }
      revoked_tokens: {
        Row: { jti: string; expires_at: string }
        Insert: { jti: string; expires_at: string }
        Update: Partial<Database['public']['Tables']['revoked_tokens']['Insert']>
        Relationships: []
      }
      jobs: {
        Row: {
          id: string; type: string; payload: Json; status: string
          attempts: number; result: Json | null; error: string | null; created_at: string
        }
        Insert: { type: string; payload: Json; status: string; attempts: number }
        Update: Partial<{
          type: string; payload: Json; status: string; attempts: number
          result: Json | null; error: string | null
        }>
        Relationships: []
      }
      notification_preferences: {
        Row: {
          id: string; cooperative_id: string
          channel_in_app: boolean; channel_email: boolean; channel_webhook: boolean
          email_address: string | null
          events: string[]
          created_at: string; updated_at: string
        }
        Insert: {
          cooperative_id: string
          channel_in_app?: boolean; channel_email?: boolean; channel_webhook?: boolean
          email_address?: string | null
          events?: string[]
        }
        Update: Partial<{
          cooperative_id: string
          channel_in_app: boolean; channel_email: boolean; channel_webhook: boolean
          email_address: string | null
          events: string[]
        }>
        Relationships: [{ foreignKeyName: 'notification_preferences_cooperative_id_fkey'; columns: ['cooperative_id']; referencedRelation: 'cooperatives'; referencedColumns: ['id'] }]
      }
      notifications: {
        Row: {
          id: string; cooperative_id: string; event: string
          certificate_id: string | null; title: string; body: string
          payload: Json | null; read: boolean; created_at: string
        }
        Insert: {
          cooperative_id: string; event: string
          certificate_id?: string | null; title: string; body: string
          payload?: Json | null; read?: boolean
        }
        Update: Partial<{
          cooperative_id: string; event: string
          certificate_id: string | null; title: string; body: string
          payload: Json | null; read: boolean
        }>
        Relationships: [
          { foreignKeyName: 'notifications_cooperative_id_fkey'; columns: ['cooperative_id']; referencedRelation: 'cooperatives'; referencedColumns: ['id'] },
          { foreignKeyName: 'notifications_certificate_id_fkey'; columns: ['certificate_id']; referencedRelation: 'certificates'; referencedColumns: ['id'] }
        ]
      }
      notification_deliveries: {
        Row: {
          id: string; notification_id: string; channel: 'in_app' | 'email' | 'webhook'
          status: 'pending' | 'delivered' | 'failed'
          attempts: number; last_error: string | null
          next_attempt_at: string | null; delivered_at: string | null
          created_at: string; updated_at: string
        }
        Insert: {
          notification_id: string; channel: 'in_app' | 'email' | 'webhook'
          status?: 'pending' | 'delivered' | 'failed'
          attempts?: number; last_error?: string | null
          next_attempt_at?: string | null; delivered_at?: string | null
        }
        Update: Partial<{
          notification_id: string; channel: 'in_app' | 'email' | 'webhook'
          status: 'pending' | 'delivered' | 'failed'
          attempts: number; last_error: string | null
          next_attempt_at: string | null; delivered_at: string | null
        }>
        Relationships: [{ foreignKeyName: 'notification_deliveries_notification_id_fkey'; columns: ['notification_id']; referencedRelation: 'notifications'; referencedColumns: ['id'] }]
      }
    }
    Views: Record<string, never>
    Functions: {
      get_cooperative_trends: {
        Args: { target_cooperative_id: string; start_date: string; end_date: string; granularity: string }
        Returns: { period: string; kwh: number; certs_issued: number; certs_retired: number }[]
      }
      get_cooperative_meter_stats: {
        Args: { target_cooperative_id: string; start_date: string; end_date: string }
        Returns: { meter_id: string; serial_number: string; name: string; total_kwh: number; reading_count: number }[]
      }
    }
    Enums: Record<string, never>
  }
}
