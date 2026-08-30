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
    };
    Enums: Record<string, never>;
  };
}
