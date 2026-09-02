/**
 * Hand-written database types, matching supabase/migrations/ exactly.
 *
 * Normally these come from `supabase gen types typescript --linked`, run
 * against a live project. That command needs a linked Supabase project
 * (network access to it), which isn't available while developing this
 * batch — so this file is maintained by hand instead, mirroring the actual
 * migrations table-for-table. Once a project is linked, regenerate this
 * file with the real command and this comment (and the hand-maintenance
 * burden) goes away.
 *
 * Shape matches `supabase gen types` output so a future codegen run is a
 * drop-in replacement, not a rewrite of every call site.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      restaurants: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string | null;
          logo_url: string | null;
          cover_image_url: string | null;
          phone: string | null;
          address: string | null;
          city: string | null;
          state: string | null;
          postal_code: string | null;
          country: string | null;
          timezone: string;
          currency: string;
          tax_rate: number;
          service_charge: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          description?: string | null;
          logo_url?: string | null;
          cover_image_url?: string | null;
          phone?: string | null;
          address?: string | null;
          city?: string | null;
          state?: string | null;
          postal_code?: string | null;
          country?: string | null;
          timezone?: string;
          currency?: string;
          tax_rate?: number;
          service_charge?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["restaurants"]["Insert"]>;
        Relationships: [];
      };
      restaurant_users: {
        Row: {
          id: string;
          restaurant_id: string;
          user_id: string;
          role: "owner" | "manager" | "kitchen" | "staff";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          user_id: string;
          role: "owner" | "manager" | "kitchen" | "staff";
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["restaurant_users"]["Insert"]
        >;
        Relationships: [];
      };
      restaurant_settings: {
        Row: {
          id: string;
          restaurant_id: string;
          accepting_orders: boolean;
          allow_customer_notes: boolean;
          allow_ai_recommendations: boolean;
          allow_upselling: boolean;
          max_order_items: number;
          payment_timing: "at_order" | "at_end";
          accept_card: boolean;
          accept_cash: boolean;
          tipping_enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          accepting_orders?: boolean;
          allow_customer_notes?: boolean;
          allow_ai_recommendations?: boolean;
          allow_upselling?: boolean;
          max_order_items?: number;
          payment_timing?: "at_order" | "at_end";
          accept_card?: boolean;
          accept_cash?: boolean;
          tipping_enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["restaurant_settings"]["Insert"]
        >;
        Relationships: [];
      };
      tables: {
        Row: {
          id: string;
          restaurant_id: string;
          table_number: string;
          display_name: string | null;
          is_active: boolean;
          public_token: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          table_number: string;
          display_name?: string | null;
          is_active?: boolean;
          public_token?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["tables"]["Insert"]>;
        Relationships: [];
      };
      categories: {
        Row: {
          id: string;
          restaurant_id: string;
          name: string;
          description: string | null;
          display_order: number;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          name: string;
          description?: string | null;
          display_order?: number;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["categories"]["Insert"]>;
        Relationships: [];
      };
      menu_items: {
        Row: {
          id: string;
          restaurant_id: string;
          category_id: string;
          name: string;
          slug: string;
          description: string | null;
          price: number;
          image_url: string | null;
          is_available: boolean;
          is_vegetarian: boolean;
          is_vegan: boolean;
          is_spicy: boolean;
          spice_level: "none" | "mild" | "medium" | "hot" | "very_hot" | null;
          contains_nuts: boolean;
          contains_dairy: boolean;
          contains_gluten: boolean;
          preparation_time: number | null;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          category_id: string;
          name: string;
          slug: string;
          description?: string | null;
          price: number;
          image_url?: string | null;
          is_available?: boolean;
          is_vegetarian?: boolean;
          is_vegan?: boolean;
          is_spicy?: boolean;
          spice_level?: "none" | "mild" | "medium" | "hot" | "very_hot" | null;
          contains_nuts?: boolean;
          contains_dairy?: boolean;
          contains_gluten?: boolean;
          preparation_time?: number | null;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["menu_items"]["Insert"]>;
        Relationships: [];
      };
      menu_item_modifiers: {
        Row: {
          id: string;
          restaurant_id: string;
          menu_item_id: string;
          name: string;
          description: string | null;
          is_required: boolean;
          min_selections: number;
          max_selections: number;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          menu_item_id: string;
          name: string;
          description?: string | null;
          is_required?: boolean;
          min_selections?: number;
          max_selections?: number;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["menu_item_modifiers"]["Insert"]
        >;
        Relationships: [];
      };
      modifier_options: {
        Row: {
          id: string;
          modifier_id: string;
          name: string;
          price_adjustment: number;
          is_available: boolean;
          display_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          modifier_id: string;
          name: string;
          price_adjustment?: number;
          is_available?: boolean;
          display_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["modifier_options"]["Insert"]
        >;
        Relationships: [];
      };
      ingredients: {
        Row: {
          id: string;
          restaurant_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["ingredients"]["Insert"]>;
        Relationships: [];
      };
      menu_item_ingredients: {
        Row: {
          id: string;
          restaurant_id: string;
          menu_item_id: string;
          ingredient_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          menu_item_id: string;
          ingredient_id: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["menu_item_ingredients"]["Insert"]
        >;
        Relationships: [];
      };
      allergens: {
        Row: {
          id: string;
          restaurant_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["allergens"]["Insert"]>;
        Relationships: [];
      };
      menu_item_allergens: {
        Row: {
          id: string;
          restaurant_id: string;
          menu_item_id: string;
          allergen_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          menu_item_id: string;
          allergen_id: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["menu_item_allergens"]["Insert"]
        >;
        Relationships: [];
      };
      customer_sessions: {
        Row: {
          id: string;
          restaurant_id: string;
          table_id: string;
          user_id: string;
          session_token: string;
          status: "active" | "expired" | "closed";
          started_at: string;
          last_active_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          table_id: string;
          user_id: string;
          session_token?: string;
          status?: "active" | "expired" | "closed";
          started_at?: string;
          last_active_at?: string;
          expires_at: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["customer_sessions"]["Insert"]
        >;
        Relationships: [];
      };
      carts: {
        Row: {
          id: string;
          customer_session_id: string;
          restaurant_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_session_id: string;
          restaurant_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["carts"]["Insert"]>;
        Relationships: [];
      };
      cart_items: {
        Row: {
          id: string;
          cart_id: string;
          restaurant_id: string;
          menu_item_id: string;
          quantity: number;
          unit_price: number;
          modifiers_price: number;
          line_total: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          cart_id: string;
          restaurant_id: string;
          menu_item_id: string;
          quantity: number;
          unit_price: number;
          modifiers_price?: number;
          line_total: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["cart_items"]["Insert"]>;
        Relationships: [];
      };
      cart_item_modifiers: {
        Row: {
          id: string;
          cart_item_id: string;
          restaurant_id: string;
          modifier_id: string;
          modifier_option_id: string;
          name: string;
          price_adjustment: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          cart_item_id: string;
          restaurant_id: string;
          modifier_id: string;
          modifier_option_id: string;
          name: string;
          price_adjustment: number;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["cart_item_modifiers"]["Insert"]
        >;
        Relationships: [];
      };
      order_number_counters: {
        Row: {
          restaurant_id: string;
          last_number: number;
        };
        Insert: {
          restaurant_id: string;
          last_number?: number;
        };
        Update: Partial<
          Database["public"]["Tables"]["order_number_counters"]["Insert"]
        >;
        Relationships: [];
      };
      orders: {
        Row: {
          id: string;
          restaurant_id: string;
          table_id: string;
          customer_session_id: string;
          order_number: number;
          status:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled";
          subtotal: number;
          tax: number;
          service_charge: number;
          total: number;
          currency: string;
          customer_note: string | null;
          idempotency_key: string;
          created_at: string;
          updated_at: string;
          confirmed_at: string | null;
          cancelled_at: string | null;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          table_id: string;
          customer_session_id: string;
          order_number: number;
          status?:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled";
          subtotal?: number;
          tax?: number;
          service_charge?: number;
          total?: number;
          currency: string;
          customer_note?: string | null;
          idempotency_key: string;
          created_at?: string;
          updated_at?: string;
          confirmed_at?: string | null;
          cancelled_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["orders"]["Insert"]>;
        Relationships: [];
      };
      order_items: {
        Row: {
          id: string;
          restaurant_id: string;
          order_id: string;
          menu_item_id: string | null;
          item_name: string;
          quantity: number;
          unit_price: number;
          modifier_total: number;
          line_total: number;
          notes: string | null;
          ticket_group_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          order_id: string;
          menu_item_id?: string | null;
          item_name: string;
          quantity: number;
          unit_price: number;
          modifier_total?: number;
          line_total: number;
          notes?: string | null;
          ticket_group_id?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["order_items"]["Insert"]>;
        Relationships: [];
      };
      order_ticket_groups: {
        Row: {
          id: string;
          restaurant_id: string;
          label: string | null;
          status: "pending" | "confirmed" | "preparing" | "ready" | "served";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          label?: string | null;
          status?: "pending" | "confirmed" | "preparing" | "ready" | "served";
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["order_ticket_groups"]["Insert"]
        >;
        Relationships: [];
      };
      reservations: {
        Row: {
          id: string;
          restaurant_id: string;
          table_id: string;
          customer_name: string;
          customer_phone: string;
          customer_email: string | null;
          party_size: number;
          reservation_time: string;
          status:
            "confirmed" | "seated" | "completed" | "cancelled" | "no_show";
          notes: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          table_id: string;
          customer_name: string;
          customer_phone: string;
          customer_email?: string | null;
          party_size: number;
          reservation_time: string;
          status?:
            "confirmed" | "seated" | "completed" | "cancelled" | "no_show";
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["reservations"]["Insert"]>;
        Relationships: [];
      };
      restaurant_payment_accounts: {
        Row: {
          id: string;
          restaurant_id: string;
          stripe_account_id: string;
          charges_enabled: boolean;
          payouts_enabled: boolean;
          details_submitted: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          stripe_account_id: string;
          charges_enabled?: boolean;
          payouts_enabled?: boolean;
          details_submitted?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["restaurant_payment_accounts"]["Insert"]
        >;
        Relationships: [];
      };
      payment_orders: {
        Row: {
          payment_id: string;
          order_id: string;
          restaurant_id: string;
          amount: string;
        };
        Insert: {
          payment_id: string;
          order_id: string;
          restaurant_id: string;
          amount: string | number;
        };
        Update: Partial<
          Database["public"]["Tables"]["payment_orders"]["Insert"]
        >;
        Relationships: [];
      };
      order_payments: {
        Row: {
          id: string;
          restaurant_id: string;
          status: string;
          method: string;
          amount: string;
          tip_amount: string;
          /** Generated column (amount + tip_amount) — never written directly. */
          total_amount: string;
          currency: string;
          stripe_checkout_session_id: string | null;
          stripe_payment_intent_id: string | null;
          created_at: string;
          updated_at: string;
          paid_at: string | null;
          /** Added by 20260902100000_cash_payments.sql. A reversal keeps the row's amount and paid_at — it is a correction with an audit trail, not a deletion. */
          reversed_at: string | null;
          reversed_by: string | null;
          reversal_reason: string | null;
          /** The staff member who recorded a cash payment. Null for card, where Stripe is the actor rather than a person. */
          recorded_by: string | null;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          status?: string;
          method?: string;
          amount: string | number;
          tip_amount?: string | number;
          currency: string;
          stripe_checkout_session_id?: string | null;
          stripe_payment_intent_id?: string | null;
          created_at?: string;
          updated_at?: string;
          paid_at?: string | null;
          reversed_at?: string | null;
          reversed_by?: string | null;
          reversal_reason?: string | null;
          recorded_by?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["order_payments"]["Insert"]
        >;
        Relationships: [];
      };
      stripe_webhook_events: {
        Row: {
          stripe_event_id: string;
          event_type: string;
          received_at: string;
          processed_at: string | null;
        };
        Insert: {
          stripe_event_id: string;
          event_type: string;
          received_at?: string;
          processed_at?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["stripe_webhook_events"]["Insert"]
        >;
        Relationships: [];
      };
      order_item_modifiers: {
        Row: {
          id: string;
          restaurant_id: string;
          order_item_id: string;
          modifier_option_id: string | null;
          modifier_group_name: string;
          modifier_option_name: string;
          price_adjustment: number;
          quantity: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          order_item_id: string;
          modifier_option_id?: string | null;
          modifier_group_name: string;
          modifier_option_name: string;
          price_adjustment: number;
          quantity?: number;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["order_item_modifiers"]["Insert"]
        >;
        Relationships: [];
      };
      order_status_history: {
        Row: {
          id: string;
          restaurant_id: string;
          order_id: string;
          previous_status:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled"
            | null;
          status:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled";
          actor_type:
            "customer" | "owner" | "manager" | "kitchen" | "staff" | "system";
          actor_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          order_id: string;
          previous_status?:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled"
            | null;
          status:
            | "pending"
            | "confirmed"
            | "preparing"
            | "ready"
            | "served"
            | "cancelled";
          actor_type:
            "customer" | "owner" | "manager" | "kitchen" | "staff" | "system";
          actor_id?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["order_status_history"]["Insert"]
        >;
        Relationships: [];
      };
      ai_conversation_messages: {
        Row: {
          id: string;
          restaurant_id: string;
          customer_session_id: string;
          role: "user" | "assistant" | "tool";
          content: string;
          tool_name: string | null;
          tool_success: boolean | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          restaurant_id: string;
          customer_session_id: string;
          role: "user" | "assistant" | "tool";
          content: string;
          tool_name?: string | null;
          tool_success?: boolean | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["ai_conversation_messages"]["Insert"]
        >;
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          seq: number;
          restaurant_id: string;
          table_name: string;
          row_id: string;
          operation: "INSERT" | "UPDATE" | "DELETE";
          actor_id: string | null;
          actor_role: string | null;
          old_data: Json | null;
          new_data: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          seq?: number;
          restaurant_id: string;
          table_name: string;
          row_id: string;
          operation: "INSERT" | "UPDATE" | "DELETE";
          actor_id?: string | null;
          actor_role?: string | null;
          old_data?: Json | null;
          new_data?: Json | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["audit_log"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_table_by_token: {
        Args: { p_public_token: string };
        Returns: {
          table_id: string;
          restaurant_id: string;
          restaurant_slug: string;
          table_number: string;
          display_name: string | null;
        }[];
      };
      submit_order: {
        Args: { p_idempotency_key: string; p_customer_note?: string | null };
        Returns: Database["public"]["Tables"]["orders"]["Row"];
      };
      transition_order_status: {
        Args: { p_order_id: string; p_target_status: string };
        Returns: Database["public"]["Tables"]["orders"]["Row"];
      };
      is_valid_order_status_transition: {
        Args: { from_status: string; to_status: string };
        Returns: boolean;
      };
      role_can_transition_order: {
        Args: { actor_role: string; from_status: string; to_status: string };
        Returns: boolean;
      };
      get_public_order_settings: {
        Args: { target_restaurant_id: string };
        Returns: {
          accepting_orders: boolean;
          allow_customer_notes: boolean;
          allow_ai_recommendations: boolean;
          allow_upselling: boolean;
        }[];
      };
      order_belongs_to_caller: {
        Args: { target_order_id: string };
        Returns: boolean;
      };
      create_restaurant: {
        Args: {
          p_name: string;
          p_slug: string;
          p_description?: string | null;
          p_timezone?: string | null;
          p_currency?: string | null;
        };
        Returns: Database["public"]["Tables"]["restaurants"]["Row"];
      };
      current_restaurant_role: {
        Args: { target_restaurant_id: string };
        Returns: string | null;
      };
      is_restaurant_member: {
        Args: { target_restaurant_id: string };
        Returns: boolean;
      };
      is_restaurant_manager_or_owner: {
        Args: { target_restaurant_id: string };
        Returns: boolean;
      };
      count_recent_sessions_for_table: {
        Args: { p_table_id: string; p_window_seconds: number };
        Returns: number;
      };
      count_recent_orders_for_session: {
        Args: { p_customer_session_id: string; p_window_seconds: number };
        Returns: number;
      };
      get_restaurant_staff: {
        Args: { target_restaurant_id: string };
        Returns: {
          id: string;
          user_id: string;
          email: string;
          role: "owner" | "manager" | "kitchen" | "staff";
          created_at: string;
        }[];
      };
      add_restaurant_staff_by_email: {
        Args: {
          target_restaurant_id: string;
          p_email: string;
          p_role: string;
        };
        Returns: string;
      };
      order_status_rank: {
        Args: { p_status: string };
        Returns: number | null;
      };
      recompute_order_status_from_groups: {
        Args: { p_order_id: string };
        Returns: undefined;
      };
      transition_ticket_group_status: {
        Args: { p_ticket_group_id: string; p_target_status: string };
        Returns: Database["public"]["Tables"]["order_ticket_groups"]["Row"];
      };
      split_order_into_tickets: {
        Args: { p_order_id: string; p_groups: Json };
        Returns: Database["public"]["Tables"]["order_ticket_groups"]["Row"][];
      };
      merge_orders_into_ticket: {
        Args: { p_order_ids: string[]; p_label: string | null };
        Returns: Database["public"]["Tables"]["order_ticket_groups"]["Row"];
      };
      is_valid_reservation_status_transition: {
        Args: { from_status: string; to_status: string };
        Returns: boolean;
      };
      create_reservation: {
        Args: {
          p_restaurant_id: string;
          p_table_id: string;
          p_customer_name: string;
          p_customer_phone: string;
          p_customer_email: string | null;
          p_party_size: number;
          p_reservation_time: string;
          p_notes: string | null;
        };
        Returns: Database["public"]["Tables"]["reservations"]["Row"];
      };
      update_reservation_details: {
        Args: {
          p_reservation_id: string;
          p_customer_name: string;
          p_customer_phone: string;
          p_customer_email: string | null;
          p_party_size: number;
          p_notes: string | null;
        };
        Returns: Database["public"]["Tables"]["reservations"]["Row"];
      };
      transition_reservation_status: {
        Args: { p_reservation_id: string; p_target_status: string };
        Returns: Database["public"]["Tables"]["reservations"]["Row"];
      };
      link_restaurant_payment_account: {
        Args: { p_restaurant_id: string; p_stripe_account_id: string };
        Returns: Database["public"]["Tables"]["restaurant_payment_accounts"]["Row"];
      };
      sync_restaurant_payment_account_status: {
        Args: {
          p_restaurant_id: string;
          p_charges_enabled: boolean;
          p_payouts_enabled: boolean;
          p_details_submitted: boolean;
        };
        Returns: Database["public"]["Tables"]["restaurant_payment_accounts"]["Row"];
      };
      get_takings_summary: {
        Args: {
          target_restaurant_id: string;
          p_from: string;
          p_to: string;
        };
        Returns: {
          gross: string;
          refunded: string;
          refunds_pending: string;
          net: string;
          tips: string;
          payment_count: number;
          order_count: number;
          average_order_value: string;
        }[];
      };
      get_takings_by_method: {
        Args: {
          target_restaurant_id: string;
          p_from: string;
          p_to: string;
        };
        Returns: {
          method: string;
          payment_count: number;
          gross: string;
          refunded: string;
          net: string;
        }[];
      };
      get_payment_history: {
        Args: {
          target_restaurant_id: string;
          p_from: string;
          p_to: string;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          payment_id: string;
          created_at: string;
          paid_at: string | null;
          status: string;
          method: string;
          amount: string;
          tip_amount: string;
          total_amount: string;
          refunded: string;
          currency: string;
          order_numbers: number[];
          stripe_payment_intent_id: string | null;
          reversed_at: string | null;
        }[];
      };
      get_best_selling_items: {
        Args: {
          target_restaurant_id: string;
          p_from: string;
          p_to: string;
          p_limit?: number;
        };
        Returns: {
          item_name: string;
          quantity_sold: string;
          revenue: string;
          order_count: number;
        }[];
      };
      get_public_payment_settings: {
        Args: { target_restaurant_id: string };
        Returns: { can_take_card: boolean; tipping_enabled: boolean }[];
      };
      start_order_payment: {
        Args: {
          p_order_id: string;
          p_tip_amount?: number;
        };
        Returns: {
          payment_id: string;
          amount: string;
          tip_amount: string;
          total_amount: string;
          currency: string;
          stripe_account_id: string;
        }[];
      };
      start_tab_payment: {
        Args: {
          p_tip_amount?: number;
        };
        Returns: {
          payment_id: string;
          amount: string;
          tip_amount: string;
          total_amount: string;
          currency: string;
          stripe_account_id: string;
          order_count: number;
        }[];
      };
      attach_payment_checkout_session: {
        Args: {
          p_payment_id: string;
          p_checkout_session_id: string;
        };
        Returns: undefined;
      };
      mark_order_payment_succeeded: {
        Args: {
          p_checkout_session_id: string;
          p_payment_intent_id: string | null;
        };
        Returns: boolean;
      };
      payment_refunded_total: {
        Args: { p_payment_id: string };
        Returns: number;
      };
      start_refund: {
        Args: {
          p_payment_id: string;
          p_amount: number | null;
          p_reason: string;
        };
        Returns: {
          refund_id: string;
          amount: string;
          currency: string;
          stripe_payment_intent_id: string;
          stripe_account_id: string;
        }[];
      };
      attach_refund_stripe_id: {
        Args: {
          p_refund_id: string;
          p_stripe_refund_id: string;
          p_succeeded: boolean;
        };
        Returns: undefined;
      };
      mark_refund_settled: {
        Args: { p_stripe_refund_id: string; p_status: string };
        Returns: boolean;
      };
      cancel_pending_refund: {
        Args: { p_refund_id: string };
        Returns: boolean;
      };
      mark_order_payment_failed: {
        Args: {
          p_checkout_session_id: string;
          p_status: string;
        };
        Returns: boolean;
      };
      record_cash_payment: {
        Args: {
          p_order_ids: string[];
          p_tip_amount?: number;
        };
        /** The new payment's id. The amount is summed from the orders, never supplied by the caller. */
        Returns: string;
      };
      reverse_cash_payment: {
        Args: {
          p_payment_id: string;
          p_reason: string;
        };
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
  };
}
