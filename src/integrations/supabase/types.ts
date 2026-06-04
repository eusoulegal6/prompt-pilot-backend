export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_apps: {
        Row: {
          app_key: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          app_key: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          app_key?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      app_admins: {
        Row: {
          created_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          app_key: string
          created_at: string
          id: string
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          app_key: string
          created_at?: string
          id?: string
          settings?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          app_key?: string
          created_at?: string
          id?: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      appointments: {
        Row: {
          booked_at: string
          created_at: string
          date: string
          id: string
          name: string
          phone: string
          service: string
          thread_id: string
          time: string
          user_id: string
        }
        Insert: {
          booked_at?: string
          created_at?: string
          date: string
          id?: string
          name: string
          phone: string
          service: string
          thread_id?: string
          time: string
          user_id: string
        }
        Update: {
          booked_at?: string
          created_at?: string
          date?: string
          id?: string
          name?: string
          phone?: string
          service?: string
          thread_id?: string
          time?: string
          user_id?: string
        }
        Relationships: []
      }
      chat_snapshots: {
        Row: {
          ack: number | null
          body: string | null
          captured_at: string
          created_at: string
          extension_version: string | null
          from_me: boolean | null
          has_reaction: boolean | null
          id: number
          is_forwarded: boolean | null
          msg_timestamp: number | null
          msg_type: string | null
          provider: string
          raw_payload: Json | null
          source: string | null
          thread_id: string
          unread_count: number | null
          user_id: string
        }
        Insert: {
          ack?: number | null
          body?: string | null
          captured_at?: string
          created_at?: string
          extension_version?: string | null
          from_me?: boolean | null
          has_reaction?: boolean | null
          id?: number
          is_forwarded?: boolean | null
          msg_timestamp?: number | null
          msg_type?: string | null
          provider?: string
          raw_payload?: Json | null
          source?: string | null
          thread_id: string
          unread_count?: number | null
          user_id: string
        }
        Update: {
          ack?: number | null
          body?: string | null
          captured_at?: string
          created_at?: string
          extension_version?: string | null
          from_me?: boolean | null
          has_reaction?: boolean | null
          id?: number
          is_forwarded?: boolean | null
          msg_timestamp?: number | null
          msg_type?: string | null
          provider?: string
          raw_payload?: Json | null
          source?: string | null
          thread_id?: string
          unread_count?: number | null
          user_id?: string
        }
        Relationships: []
      }
      extension_pair_codes: {
        Row: {
          code: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          user_id: string
        }
        Insert: {
          code: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          user_id: string
        }
        Update: {
          code?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      extension_tokens: {
        Row: {
          created_at: string
          id: string
          label: string | null
          last_used_at: string | null
          revoked_at: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          last_used_at?: string | null
          revoked_at?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      pageviews: {
        Row: {
          app_key: string
          country: string | null
          created_at: string
          id: string
          path: string
          referrer: string | null
          session_id: string
          user_agent: string | null
          user_id: string | null
          visitor_id: string
        }
        Insert: {
          app_key: string
          country?: string | null
          created_at?: string
          id?: string
          path: string
          referrer?: string | null
          session_id: string
          user_agent?: string | null
          user_id?: string | null
          visitor_id: string
        }
        Update: {
          app_key?: string
          country?: string | null
          created_at?: string
          id?: string
          path?: string
          referrer?: string | null
          session_id?: string
          user_agent?: string | null
          user_id?: string | null
          visitor_id?: string
        }
        Relationships: []
      }
      reply_logs: {
        Row: {
          created_at: string
          decision: string
          id: string
          input_tokens: number
          latest_message: string | null
          output_tokens: number
          period: string
          preview: string | null
          sender_email: string | null
          source_url: string | null
          subject: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          decision?: string
          id?: string
          input_tokens?: number
          latest_message?: string | null
          output_tokens?: number
          period: string
          preview?: string | null
          sender_email?: string | null
          source_url?: string | null
          subject?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          decision?: string
          id?: string
          input_tokens?: number
          latest_message?: string | null
          output_tokens?: number
          period?: string
          preview?: string | null
          sender_email?: string | null
          source_url?: string | null
          subject?: string | null
          user_id?: string
        }
        Relationships: []
      }
      thread_state_history: {
        Row: {
          backend_decision: string
          created_at: string
          event_type: string
          id: string
          occurred_at: string | null
          payload: Json | null
          provider: string
          review_reason: string
          review_summary: string
          status_value: string
          thread_id: string
          thread_state_id: string
          user_id: string
        }
        Insert: {
          backend_decision?: string
          created_at?: string
          event_type: string
          id?: string
          occurred_at?: string | null
          payload?: Json | null
          provider: string
          review_reason?: string
          review_summary?: string
          status_value?: string
          thread_id: string
          thread_state_id: string
          user_id: string
        }
        Update: {
          backend_decision?: string
          created_at?: string
          event_type?: string
          id?: string
          occurred_at?: string | null
          payload?: Json | null
          provider?: string
          review_reason?: string
          review_summary?: string
          status_value?: string
          thread_id?: string
          thread_state_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "thread_state_history_thread_state_id_fkey"
            columns: ["thread_state_id"]
            isOneToOne: false
            referencedRelation: "thread_states"
            referencedColumns: ["id"]
          },
        ]
      }
      thread_states: {
        Row: {
          auto_send: boolean
          backend_decision: string
          business_action: string
          created_at: string
          customer_goal: string
          draft_id: string
          draft_preview: string
          extension_version: string | null
          id: string
          intent_category: string
          intent_classified_at: string | null
          intent_confidence: number
          intent_reason: string
          intent_review_reason: string
          intent_source: string
          intent_subcategory: string
          intent_urgency: string
          last_auto_sent_at: string | null
          last_auto_sent_message_key: string
          last_draft_at: string | null
          last_error: string
          last_event_at: string | null
          last_event_type: string | null
          last_handled_message_key: string
          last_opened_at: string | null
          last_sent_at: string | null
          last_snapshot: Json | null
          latest_message: string | null
          needs_human_review: boolean
          preview: string | null
          provider: string
          queue_scope: string | null
          queued_at: string | null
          review_active: boolean
          review_opened_at: string | null
          review_reason: string
          review_resolved_at: string | null
          review_summary: string
          sender: string | null
          snapshot_ack: number | null
          snapshot_body: string | null
          snapshot_captured_at: string | null
          snapshot_from_me: boolean | null
          snapshot_has_reaction: boolean | null
          snapshot_is_forwarded: boolean | null
          snapshot_msg_timestamp: number | null
          snapshot_msg_type: string | null
          snapshot_unread_count: number | null
          source: string | null
          source_url: string | null
          status_value: string
          subject: string | null
          thread_id: string
          thread_url: string | null
          unread: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          auto_send?: boolean
          backend_decision?: string
          business_action?: string
          created_at?: string
          customer_goal?: string
          draft_id?: string
          draft_preview?: string
          extension_version?: string | null
          id?: string
          intent_category?: string
          intent_classified_at?: string | null
          intent_confidence?: number
          intent_reason?: string
          intent_review_reason?: string
          intent_source?: string
          intent_subcategory?: string
          intent_urgency?: string
          last_auto_sent_at?: string | null
          last_auto_sent_message_key?: string
          last_draft_at?: string | null
          last_error?: string
          last_event_at?: string | null
          last_event_type?: string | null
          last_handled_message_key?: string
          last_opened_at?: string | null
          last_sent_at?: string | null
          last_snapshot?: Json | null
          latest_message?: string | null
          needs_human_review?: boolean
          preview?: string | null
          provider?: string
          queue_scope?: string | null
          queued_at?: string | null
          review_active?: boolean
          review_opened_at?: string | null
          review_reason?: string
          review_resolved_at?: string | null
          review_summary?: string
          sender?: string | null
          snapshot_ack?: number | null
          snapshot_body?: string | null
          snapshot_captured_at?: string | null
          snapshot_from_me?: boolean | null
          snapshot_has_reaction?: boolean | null
          snapshot_is_forwarded?: boolean | null
          snapshot_msg_timestamp?: number | null
          snapshot_msg_type?: string | null
          snapshot_unread_count?: number | null
          source?: string | null
          source_url?: string | null
          status_value?: string
          subject?: string | null
          thread_id: string
          thread_url?: string | null
          unread?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          auto_send?: boolean
          backend_decision?: string
          business_action?: string
          created_at?: string
          customer_goal?: string
          draft_id?: string
          draft_preview?: string
          extension_version?: string | null
          id?: string
          intent_category?: string
          intent_classified_at?: string | null
          intent_confidence?: number
          intent_reason?: string
          intent_review_reason?: string
          intent_source?: string
          intent_subcategory?: string
          intent_urgency?: string
          last_auto_sent_at?: string | null
          last_auto_sent_message_key?: string
          last_draft_at?: string | null
          last_error?: string
          last_event_at?: string | null
          last_event_type?: string | null
          last_handled_message_key?: string
          last_opened_at?: string | null
          last_sent_at?: string | null
          last_snapshot?: Json | null
          latest_message?: string | null
          needs_human_review?: boolean
          preview?: string | null
          provider?: string
          queue_scope?: string | null
          queued_at?: string | null
          review_active?: boolean
          review_opened_at?: string | null
          review_reason?: string
          review_resolved_at?: string | null
          review_summary?: string
          sender?: string | null
          snapshot_ack?: number | null
          snapshot_body?: string | null
          snapshot_captured_at?: string | null
          snapshot_from_me?: boolean | null
          snapshot_has_reaction?: boolean | null
          snapshot_is_forwarded?: boolean | null
          snapshot_msg_timestamp?: number | null
          snapshot_msg_type?: string | null
          snapshot_unread_count?: number | null
          source?: string | null
          source_url?: string | null
          status_value?: string
          subject?: string | null
          thread_id?: string
          thread_url?: string | null
          unread?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      usage_counters: {
        Row: {
          app_key: string
          created_at: string
          emails_used: number
          id: string
          input_tokens_used: number
          output_tokens_used: number
          period: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_key?: string
          created_at?: string
          emails_used?: number
          id?: string
          input_tokens_used?: number
          output_tokens_used?: number
          period: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_key?: string
          created_at?: string
          emails_used?: number
          id?: string
          input_tokens_used?: number
          output_tokens_used?: number
          period?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      whisper_invocations: {
        Row: {
          chars: number | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          mime_type: string | null
          provider: string | null
          status: string
          transcript: string | null
          user_id: string
        }
        Insert: {
          chars?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          mime_type?: string | null
          provider?: string | null
          status: string
          transcript?: string | null
          user_id: string
        }
        Update: {
          chars?: number | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          mime_type?: string | null
          provider?: string | null
          status?: string
          transcript?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_app_admin: { Args: { _user_id: string }; Returns: boolean }
      user_has_app: {
        Args: { _app_key: string; _user_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
