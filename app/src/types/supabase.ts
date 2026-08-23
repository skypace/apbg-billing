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
      app_config: {
        Row: {
          key: string
          updated_at: string
          value: string | null
        }
        Insert: {
          key: string
          updated_at?: string
          value?: string | null
        }
        Update: {
          key?: string
          updated_at?: string
          value?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor: string | null
          after: Json | null
          at: string
          before: Json | null
          id: number
          ip: string | null
          meta: Json | null
          prev_hash: string | null
          row_hash: string | null
          row_id: string | null
          table_name: string | null
          user_agent: string | null
        }
        Insert: {
          action: string
          actor?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          id?: number
          ip?: string | null
          meta?: Json | null
          prev_hash?: string | null
          row_hash?: string | null
          row_id?: string | null
          table_name?: string | null
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          id?: number
          ip?: string | null
          meta?: Json | null
          prev_hash?: string | null
          row_hash?: string | null
          row_id?: string | null
          table_name?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      brix_warehouse: {
        Row: {
          code: string | null
          has_warranty: string | null
          id: number
          installed_on: string | null
          location: string | null
          manufacturer: string | null
          model: string | null
          name: string | null
          resq_id: string | null
          serial: string | null
          synced_at: string | null
          warranty_expires: string | null
        }
        Insert: {
          code?: string | null
          has_warranty?: string | null
          id?: never
          installed_on?: string | null
          location?: string | null
          manufacturer?: string | null
          model?: string | null
          name?: string | null
          resq_id?: string | null
          serial?: string | null
          synced_at?: string | null
          warranty_expires?: string | null
        }
        Update: {
          code?: string | null
          has_warranty?: string | null
          id?: never
          installed_on?: string | null
          location?: string | null
          manufacturer?: string | null
          model?: string | null
          name?: string | null
          resq_id?: string | null
          serial?: string | null
          synced_at?: string | null
          warranty_expires?: string | null
        }
        Relationships: []
      }
      checkout_orders: {
        Row: {
          bol_generated_at: string | null
          bol_key: string | null
          bol_version: number | null
          carrier: string | null
          carrier_bill_attached_at: string | null
          carrier_bol_file_key: string | null
          carrier_bol_number: string | null
          carrier_qbo_bill_amount: number | null
          carrier_qbo_bill_id: string | null
          completed_at: string | null
          created_at: string | null
          created_by: string | null
          customer_id: number | null
          estimated_delivery: string | null
          freight_bill_file_key: string | null
          freight_cost: number | null
          freight_vendor_name: string | null
          id: number
          job_id: number | null
          kind: string
          notes: string | null
          order_number: string
          pdf_key: string | null
          qbo_bill_doc_number: string | null
          qbo_bill_id: string | null
          sf_job_id: string | null
          sf_job_number: string | null
          shipped_at: string | null
          status: string | null
          store_order_id: number | null
          target_store: string
          tracking_number: string | null
          tracking_status: string | null
        }
        Insert: {
          bol_generated_at?: string | null
          bol_key?: string | null
          bol_version?: number | null
          carrier?: string | null
          carrier_bill_attached_at?: string | null
          carrier_bol_file_key?: string | null
          carrier_bol_number?: string | null
          carrier_qbo_bill_amount?: number | null
          carrier_qbo_bill_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          estimated_delivery?: string | null
          freight_bill_file_key?: string | null
          freight_cost?: number | null
          freight_vendor_name?: string | null
          id?: never
          job_id?: number | null
          kind?: string
          notes?: string | null
          order_number: string
          pdf_key?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          shipped_at?: string | null
          status?: string | null
          store_order_id?: number | null
          target_store: string
          tracking_number?: string | null
          tracking_status?: string | null
        }
        Update: {
          bol_generated_at?: string | null
          bol_key?: string | null
          bol_version?: number | null
          carrier?: string | null
          carrier_bill_attached_at?: string | null
          carrier_bol_file_key?: string | null
          carrier_bol_number?: string | null
          carrier_qbo_bill_amount?: number | null
          carrier_qbo_bill_id?: string | null
          completed_at?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          estimated_delivery?: string | null
          freight_bill_file_key?: string | null
          freight_cost?: number | null
          freight_vendor_name?: string | null
          id?: never
          job_id?: number | null
          kind?: string
          notes?: string | null
          order_number?: string
          pdf_key?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          shipped_at?: string | null
          status?: string | null
          store_order_id?: number | null
          target_store?: string
          tracking_number?: string | null
          tracking_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checkout_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_orders_store_order_id_fkey"
            columns: ["store_order_id"]
            isOneToOne: false
            referencedRelation: "store_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_items: {
        Row: {
          active: boolean | null
          category: string | null
          contract_id: number | null
          created_at: string | null
          description: string | null
          id: number
          image_key: string | null
          item_type: string | null
          manufacturer: string | null
          model: string | null
          name: string
          our_cost: number | null
          parent_item_id: number | null
          qbo_item_id: string | null
          qbo_item_name: string | null
          requires_serial: boolean
          sales_price: number
          sku: string | null
          sort_order: number | null
          spec_sheet_key: string | null
          taxable: boolean
          weight_lbs: number | null
        }
        Insert: {
          active?: boolean | null
          category?: string | null
          contract_id?: number | null
          created_at?: string | null
          description?: string | null
          id?: never
          image_key?: string | null
          item_type?: string | null
          manufacturer?: string | null
          model?: string | null
          name: string
          our_cost?: number | null
          parent_item_id?: number | null
          qbo_item_id?: string | null
          qbo_item_name?: string | null
          requires_serial?: boolean
          sales_price: number
          sku?: string | null
          sort_order?: number | null
          spec_sheet_key?: string | null
          taxable?: boolean
          weight_lbs?: number | null
        }
        Update: {
          active?: boolean | null
          category?: string | null
          contract_id?: number | null
          created_at?: string | null
          description?: string | null
          id?: never
          image_key?: string | null
          item_type?: string | null
          manufacturer?: string | null
          model?: string | null
          name?: string
          our_cost?: number | null
          parent_item_id?: number | null
          qbo_item_id?: string | null
          qbo_item_name?: string | null
          requires_serial?: boolean
          sales_price?: number
          sku?: string | null
          sort_order?: number | null
          spec_sheet_key?: string | null
          taxable?: boolean
          weight_lbs?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "contract_items_contract_id_fkey"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "customer_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_items_parent_item_id_fkey"
            columns: ["parent_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_contracts: {
        Row: {
          created_at: string | null
          customer_id: number | null
          default_tax_rate: number | null
          effective_date: string | null
          expires_date: string | null
          id: number
          name: string
          notes: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          customer_id?: number | null
          default_tax_rate?: number | null
          effective_date?: string | null
          expires_date?: string | null
          id?: never
          name: string
          notes?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          customer_id?: number | null
          default_tax_rate?: number | null
          effective_date?: string | null
          expires_date?: string | null
          id?: never
          name?: string
          notes?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_contracts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          accent_color: string | null
          active: boolean | null
          admin_pin: string
          ai_instructions: string | null
          billing_address: string | null
          billing_email: string | null
          config: Json | null
          created_at: string | null
          default_freight_markup_pct: number
          default_freight_per_move: number
          default_qbo_customer_id: string | null
          default_qbo_customer_name: string | null
          id: number
          logo_url: string | null
          name: string
          portal_subtitle: string | null
          qbo_customer_id: string | null
          qbo_customer_name: string | null
          qbo_rent_item_id: string | null
          qbo_search_filter: string | null
          qbo_vendor_bill_term: string | null
          resq_facility_filter: string | null
          resq_warehouse_filter: string | null
          settings_code: string | null
          slug: string
          viewer_pin: string
        }
        Insert: {
          accent_color?: string | null
          active?: boolean | null
          admin_pin: string
          ai_instructions?: string | null
          billing_address?: string | null
          billing_email?: string | null
          config?: Json | null
          created_at?: string | null
          default_freight_markup_pct?: number
          default_freight_per_move?: number
          default_qbo_customer_id?: string | null
          default_qbo_customer_name?: string | null
          id?: never
          logo_url?: string | null
          name: string
          portal_subtitle?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          qbo_rent_item_id?: string | null
          qbo_search_filter?: string | null
          qbo_vendor_bill_term?: string | null
          resq_facility_filter?: string | null
          resq_warehouse_filter?: string | null
          settings_code?: string | null
          slug: string
          viewer_pin: string
        }
        Update: {
          accent_color?: string | null
          active?: boolean | null
          admin_pin?: string
          ai_instructions?: string | null
          billing_address?: string | null
          billing_email?: string | null
          config?: Json | null
          created_at?: string | null
          default_freight_markup_pct?: number
          default_freight_per_move?: number
          default_qbo_customer_id?: string | null
          default_qbo_customer_name?: string | null
          id?: never
          logo_url?: string | null
          name?: string
          portal_subtitle?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          qbo_rent_item_id?: string | null
          qbo_search_filter?: string | null
          qbo_vendor_bill_term?: string | null
          resq_facility_filter?: string | null
          resq_warehouse_filter?: string | null
          settings_code?: string | null
          slug?: string
          viewer_pin?: string
        }
        Relationships: []
      }
      email_contacts: {
        Row: {
          created_at: string
          customer_id: number | null
          email: string
          email_lc: string
          id: number
          last_source: string | null
          last_used_at: string
          name: string | null
          use_count: number
        }
        Insert: {
          created_at?: string
          customer_id?: number | null
          email: string
          email_lc: string
          id?: number
          last_source?: string | null
          last_used_at?: string
          name?: string | null
          use_count?: number
        }
        Update: {
          created_at?: string
          customer_id?: number | null
          email?: string
          email_lc?: string
          id?: number
          last_source?: string | null
          last_used_at?: string
          name?: string | null
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "email_contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      email_send_log: {
        Row: {
          customer_id: number | null
          doc_id: number
          doc_type: string
          from_email: string | null
          id: number
          meta: Json | null
          recipients_bcc: string[]
          recipients_cc: string[]
          recipients_to: string[]
          reply_to: string | null
          resend_id: string | null
          sent_at: string
          sent_by: string | null
          source: string | null
          subject: string | null
        }
        Insert: {
          customer_id?: number | null
          doc_id: number
          doc_type: string
          from_email?: string | null
          id?: number
          meta?: Json | null
          recipients_bcc?: string[]
          recipients_cc?: string[]
          recipients_to?: string[]
          reply_to?: string | null
          resend_id?: string | null
          sent_at?: string
          sent_by?: string | null
          source?: string | null
          subject?: string | null
        }
        Update: {
          customer_id?: number | null
          doc_id?: number
          doc_type?: string
          from_email?: string | null
          id?: number
          meta?: Json | null
          recipients_bcc?: string[]
          recipients_cc?: string[]
          recipients_to?: string[]
          reply_to?: string | null
          resend_id?: string | null
          sent_at?: string
          sent_by?: string | null
          source?: string | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_send_log_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      equipment_requests: {
        Row: {
          action: string
          condition: string | null
          created_at: string | null
          customer_id: number | null
          equipment_code: string | null
          equipment_id: string | null
          equipment_name: string
          fulfillment_date: string | null
          id: string
          manufacturer: string | null
          model_no: string | null
          move_order_id: number | null
          notes: string | null
          photo_key: string | null
          requested_by: string | null
          requestor_email: string
          resolved_at: string | null
          serial_no: string | null
          sf_error: string | null
          sf_job_id: string | null
          sf_job_number: string | null
          sf_status: string | null
          status: string | null
        }
        Insert: {
          action: string
          condition?: string | null
          created_at?: string | null
          customer_id?: number | null
          equipment_code?: string | null
          equipment_id?: string | null
          equipment_name: string
          fulfillment_date?: string | null
          id: string
          manufacturer?: string | null
          model_no?: string | null
          move_order_id?: number | null
          notes?: string | null
          photo_key?: string | null
          requested_by?: string | null
          requestor_email: string
          resolved_at?: string | null
          serial_no?: string | null
          sf_error?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          sf_status?: string | null
          status?: string | null
        }
        Update: {
          action?: string
          condition?: string | null
          created_at?: string | null
          customer_id?: number | null
          equipment_code?: string | null
          equipment_id?: string | null
          equipment_name?: string
          fulfillment_date?: string | null
          id?: string
          manufacturer?: string | null
          model_no?: string | null
          move_order_id?: number | null
          notes?: string | null
          photo_key?: string | null
          requested_by?: string | null
          requestor_email?: string
          resolved_at?: string | null
          serial_no?: string | null
          sf_error?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          sf_status?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "equipment_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      job_bills: {
        Row: {
          amount: number
          bill_date: string | null
          bill_file_key: string | null
          billed_at: string | null
          billed_by: string | null
          cost_type: string
          created_at: string
          created_by: string | null
          customer_charge_amount: number | null
          customer_so_line_id: number | null
          id: number
          invoice_number: string | null
          markup_pct: number
          notes: string | null
          qbo_bill_doc_number: string | null
          qbo_bill_id: string | null
          qbo_department_name: string | null
          scope_id: number
          scope_type: string
          vendor_name: string | null
        }
        Insert: {
          amount?: number
          bill_date?: string | null
          bill_file_key?: string | null
          billed_at?: string | null
          billed_by?: string | null
          cost_type?: string
          created_at?: string
          created_by?: string | null
          customer_charge_amount?: number | null
          customer_so_line_id?: number | null
          id?: number
          invoice_number?: string | null
          markup_pct?: number
          notes?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          qbo_department_name?: string | null
          scope_id: number
          scope_type: string
          vendor_name?: string | null
        }
        Update: {
          amount?: number
          bill_date?: string | null
          bill_file_key?: string | null
          billed_at?: string | null
          billed_by?: string | null
          cost_type?: string
          created_at?: string
          created_by?: string | null
          customer_charge_amount?: number | null
          customer_so_line_id?: number | null
          id?: number
          invoice_number?: string | null
          markup_pct?: number
          notes?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          qbo_department_name?: string | null
          scope_id?: number
          scope_type?: string
          vendor_name?: string | null
        }
        Relationships: []
      }
      job_files: {
        Row: {
          blob_key: string
          caption: string | null
          created_at: string | null
          file_name: string | null
          file_type: string | null
          id: number
          job_id: number
          uploaded_by: string | null
        }
        Insert: {
          blob_key: string
          caption?: string | null
          created_at?: string | null
          file_name?: string | null
          file_type?: string | null
          id?: never
          job_id: number
          uploaded_by?: string | null
        }
        Update: {
          blob_key?: string
          caption?: string | null
          created_at?: string | null
          file_name?: string | null
          file_type?: string | null
          id?: never
          job_id?: number
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_files_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_items: {
        Row: {
          category: string | null
          contract_item_id: number | null
          created_at: string | null
          description: string | null
          equipment_id: number | null
          id: number
          job_id: number
          name: string
          notes: string | null
          po_line_item_id: number | null
          qty: number | null
          status: string | null
          unit_cost: number | null
          updated_at: string | null
          vendor: string | null
        }
        Insert: {
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description?: string | null
          equipment_id?: number | null
          id?: never
          job_id: number
          name: string
          notes?: string | null
          po_line_item_id?: number | null
          qty?: number | null
          status?: string | null
          unit_cost?: number | null
          updated_at?: string | null
          vendor?: string | null
        }
        Update: {
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description?: string | null
          equipment_id?: number | null
          id?: never
          job_id?: number
          name?: string
          notes?: string | null
          po_line_item_id?: number | null
          qty?: number | null
          status?: string | null
          unit_cost?: number | null
          updated_at?: string | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_items_contract_item_id_fkey"
            columns: ["contract_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_equipment_id_fkey"
            columns: ["equipment_id"]
            isOneToOne: false
            referencedRelation: "stainless_equipment"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_items_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      job_updates: {
        Row: {
          author: string
          content: string
          created_at: string | null
          id: number
          job_id: number
          metadata: Json | null
          update_type: string | null
        }
        Insert: {
          author: string
          content: string
          created_at?: string | null
          id?: never
          job_id: number
          metadata?: Json | null
          update_type?: string | null
        }
        Update: {
          author?: string
          content?: string
          created_at?: string | null
          id?: never
          job_id?: number
          metadata?: Json | null
          update_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_updates_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          actual_complete: string | null
          actual_start: string | null
          budget: number | null
          created_at: string | null
          created_by: string | null
          customer_id: number | null
          description: string | null
          id: number
          name: string
          notes: string | null
          sf_job_id: string | null
          sf_job_number: string | null
          status: string
          store_id: number | null
          target_complete: string | null
          target_start: string | null
          updated_at: string | null
          vendor_contact_email: string | null
          vendor_contact_name: string | null
          vendor_contact_phone: string | null
          vendor_partner: string | null
        }
        Insert: {
          actual_complete?: string | null
          actual_start?: string | null
          budget?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          description?: string | null
          id?: never
          name: string
          notes?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          status?: string
          store_id?: number | null
          target_complete?: string | null
          target_start?: string | null
          updated_at?: string | null
          vendor_contact_email?: string | null
          vendor_contact_name?: string | null
          vendor_contact_phone?: string | null
          vendor_partner?: string | null
        }
        Update: {
          actual_complete?: string | null
          actual_start?: string | null
          budget?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          description?: string | null
          id?: never
          name?: string
          notes?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          status?: string
          store_id?: number | null
          target_complete?: string | null
          target_start?: string | null
          updated_at?: string | null
          vendor_contact_email?: string | null
          vendor_contact_name?: string | null
          vendor_contact_phone?: string | null
          vendor_partner?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "store_schedule"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          customer_id: number | null
          embedding: string
          file_id: number
          id: number
          job_id: number | null
          store_id: number | null
          token_count: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          customer_id?: number | null
          embedding: string
          file_id: number
          id?: number
          job_id?: number | null
          store_id?: number | null
          token_count?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          customer_id?: number | null
          embedding?: string
          file_id?: number
          id?: number
          job_id?: number | null
          store_id?: number | null
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_chunks_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "knowledge_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_chunks_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "store_schedule"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_files: {
        Row: {
          anthropic_file_id: string | null
          blob_key: string | null
          chunk_count: number
          content_type: string | null
          created_at: string
          customer_id: number | null
          description: string | null
          embedding_status: string
          error: string | null
          expires_at: string | null
          file_name: string
          file_size: number | null
          id: number
          job_id: number | null
          store_id: number | null
          tags: string[] | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          anthropic_file_id?: string | null
          blob_key?: string | null
          chunk_count?: number
          content_type?: string | null
          created_at?: string
          customer_id?: number | null
          description?: string | null
          embedding_status?: string
          error?: string | null
          expires_at?: string | null
          file_name: string
          file_size?: number | null
          id?: number
          job_id?: number | null
          store_id?: number | null
          tags?: string[] | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          anthropic_file_id?: string | null
          blob_key?: string | null
          chunk_count?: number
          content_type?: string | null
          created_at?: string
          customer_id?: number | null
          description?: string | null
          embedding_status?: string
          error?: string | null
          expires_at?: string | null
          file_name?: string
          file_size?: number | null
          id?: number
          job_id?: number | null
          store_id?: number | null
          tags?: string[] | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_files_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_files_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_files_store_id_fkey"
            columns: ["store_id"]
            isOneToOne: false
            referencedRelation: "store_schedule"
            referencedColumns: ["id"]
          },
        ]
      }
      melt_request_forwards: {
        Row: {
          attachment_count: number | null
          body_html: string | null
          body_text: string | null
          error_message: string | null
          forward_resend_ids: string[] | null
          forward_status: string
          forwarded_to: string[] | null
          from_email: string | null
          from_name: string | null
          id: number
          raw_payload: Json | null
          received_at: string
          resend_inbound_id: string | null
          subject: string | null
          to_address: string | null
        }
        Insert: {
          attachment_count?: number | null
          body_html?: string | null
          body_text?: string | null
          error_message?: string | null
          forward_resend_ids?: string[] | null
          forward_status?: string
          forwarded_to?: string[] | null
          from_email?: string | null
          from_name?: string | null
          id?: number
          raw_payload?: Json | null
          received_at?: string
          resend_inbound_id?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Update: {
          attachment_count?: number | null
          body_html?: string | null
          body_text?: string | null
          error_message?: string | null
          forward_resend_ids?: string[] | null
          forward_status?: string
          forwarded_to?: string[] | null
          from_email?: string | null
          from_name?: string | null
          id?: number
          raw_payload?: Json | null
          received_at?: string
          resend_inbound_id?: string | null
          subject?: string | null
          to_address?: string | null
        }
        Relationships: []
      }
      melt_welcome_sends: {
        Row: {
          auth_user_id: string | null
          error_message: string | null
          from_address: string
          id: number
          portal_url: string | null
          recipient_email: string
          recipient_name: string | null
          reply_to: string
          request_meta: Json | null
          sent_at: string
          ses_message_id: string | null
          status: string
          triggered_by: string | null
          user_guide_url: string | null
          username: string | null
        }
        Insert: {
          auth_user_id?: string | null
          error_message?: string | null
          from_address?: string
          id?: number
          portal_url?: string | null
          recipient_email: string
          recipient_name?: string | null
          reply_to?: string
          request_meta?: Json | null
          sent_at?: string
          ses_message_id?: string | null
          status?: string
          triggered_by?: string | null
          user_guide_url?: string | null
          username?: string | null
        }
        Update: {
          auth_user_id?: string | null
          error_message?: string | null
          from_address?: string
          id?: number
          portal_url?: string | null
          recipient_email?: string
          recipient_name?: string | null
          reply_to?: string
          request_meta?: Json | null
          sent_at?: string
          ses_message_id?: string | null
          status?: string
          triggered_by?: string | null
          user_guide_url?: string | null
          username?: string | null
        }
        Relationships: []
      }
      non_resq_equipment: {
        Row: {
          category: string | null
          condition: string | null
          contract_item_id: number | null
          created_at: string | null
          customer_id: number | null
          description: string | null
          id: number
          item_no: string | null
          model: string | null
          notes: string | null
          photo_key: string | null
          qty: number | null
          scanned_by: string | null
          serial: string | null
          vendor: string | null
          vendor_id: number | null
        }
        Insert: {
          category?: string | null
          condition?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          customer_id?: number | null
          description?: string | null
          id?: never
          item_no?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          qty?: number | null
          scanned_by?: string | null
          serial?: string | null
          vendor?: string | null
          vendor_id?: number | null
        }
        Update: {
          category?: string | null
          condition?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          customer_id?: number | null
          description?: string | null
          id?: never
          item_no?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          qty?: number | null
          scanned_by?: string | null
          serial?: string | null
          vendor?: string | null
          vendor_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_scan_contract_item"
            columns: ["contract_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_scan_vendor"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "non_resq_equipment_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_freight_bills: {
        Row: {
          created_at: string
          extracted_amount: number | null
          extracted_bol_number: string | null
          extracted_carrier: string | null
          extracted_invoice_number: string | null
          extracted_raw_json: Json | null
          extracted_vendor_name: string | null
          file_key: string | null
          id: number
          matched_checkout_order_id: number | null
          notes: string | null
          raw_email_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          source_email_from: string | null
          source_email_subject: string | null
          status: string
        }
        Insert: {
          created_at?: string
          extracted_amount?: number | null
          extracted_bol_number?: string | null
          extracted_carrier?: string | null
          extracted_invoice_number?: string | null
          extracted_raw_json?: Json | null
          extracted_vendor_name?: string | null
          file_key?: string | null
          id?: number
          matched_checkout_order_id?: number | null
          notes?: string | null
          raw_email_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source_email_from?: string | null
          source_email_subject?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          extracted_amount?: number | null
          extracted_bol_number?: string | null
          extracted_carrier?: string | null
          extracted_invoice_number?: string | null
          extracted_raw_json?: Json | null
          extracted_vendor_name?: string | null
          file_key?: string | null
          id?: number
          matched_checkout_order_id?: number | null
          notes?: string | null
          raw_email_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          source_email_from?: string | null
          source_email_subject?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_freight_bills_matched_checkout_order_id_fkey"
            columns: ["matched_checkout_order_id"]
            isOneToOne: false
            referencedRelation: "checkout_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pm_assignments: {
        Row: {
          asset_code: string | null
          asset_make: string | null
          asset_model: string | null
          asset_serial: string | null
          asset_source: string
          brix_id: number | null
          created_at: string
          created_by: string | null
          customer_id: number | null
          enabled: boolean
          frequency_per_year: number
          id: number
          last_pm_at: string | null
          manual_label: string | null
          next_pm_due: string | null
          notes: string | null
          pm_item_id: number | null
          stainless_id: number | null
          store_name: string | null
          updated_at: string
        }
        Insert: {
          asset_code?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_source: string
          brix_id?: number | null
          created_at?: string
          created_by?: string | null
          customer_id?: number | null
          enabled?: boolean
          frequency_per_year?: number
          id?: number
          last_pm_at?: string | null
          manual_label?: string | null
          next_pm_due?: string | null
          notes?: string | null
          pm_item_id?: number | null
          stainless_id?: number | null
          store_name?: string | null
          updated_at?: string
        }
        Update: {
          asset_code?: string | null
          asset_make?: string | null
          asset_model?: string | null
          asset_serial?: string | null
          asset_source?: string
          brix_id?: number | null
          created_at?: string
          created_by?: string | null
          customer_id?: number | null
          enabled?: boolean
          frequency_per_year?: number
          id?: number
          last_pm_at?: string | null
          manual_label?: string | null
          next_pm_due?: string | null
          notes?: string | null
          pm_item_id?: number | null
          stainless_id?: number | null
          store_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pm_assignments_brix_id_fkey"
            columns: ["brix_id"]
            isOneToOne: false
            referencedRelation: "brix_warehouse"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pm_assignments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pm_assignments_pm_item_id_fkey"
            columns: ["pm_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pm_assignments_stainless_id_fkey"
            columns: ["stainless_id"]
            isOneToOne: false
            referencedRelation: "stainless_equipment"
            referencedColumns: ["id"]
          },
        ]
      }
      po_line_items: {
        Row: {
          category: string | null
          contract_item_id: number | null
          created_at: string | null
          description: string
          id: number
          item_no: string | null
          line_total: number | null
          manufacturer: string | null
          model: string | null
          po_id: number
          qty_ordered: number
          qty_received: number | null
          qty_shipped: number
          store_name: string | null
          store_order_item_id: number | null
          unit_price: number | null
        }
        Insert: {
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description: string
          id?: never
          item_no?: string | null
          line_total?: number | null
          manufacturer?: string | null
          model?: string | null
          po_id: number
          qty_ordered?: number
          qty_received?: number | null
          qty_shipped?: number
          store_name?: string | null
          store_order_item_id?: number | null
          unit_price?: number | null
        }
        Update: {
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description?: string
          id?: never
          item_no?: string | null
          line_total?: number | null
          manufacturer?: string | null
          model?: string | null
          po_id?: number
          qty_ordered?: number
          qty_received?: number | null
          qty_shipped?: number
          store_name?: string | null
          store_order_item_id?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_po_line_contract_item"
            columns: ["contract_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fk_po_line_store_order_item"
            columns: ["store_order_item_id"]
            isOneToOne: false
            referencedRelation: "store_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_line_items_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      po_shipment_items: {
        Row: {
          created_at: string
          id: number
          po_line_item_id: number
          qty: number
          shipment_id: number
        }
        Insert: {
          created_at?: string
          id?: number
          po_line_item_id: number
          qty: number
          shipment_id: number
        }
        Update: {
          created_at?: string
          id?: number
          po_line_item_id?: number
          qty?: number
          shipment_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "po_shipment_items_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_shipment_items_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "po_shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      po_shipment_tracking: {
        Row: {
          carrier: string | null
          created_at: string | null
          estimated_delivery: string | null
          id: number
          item_reference: string | null
          parsed_at: string | null
          po_id: number | null
          po_line_item_id: number | null
          po_number: string
          raw_email_id: string | null
          ship_date: string | null
          source_email_from: string | null
          source_email_subject: string | null
          status: string | null
          tracking_number: string
        }
        Insert: {
          carrier?: string | null
          created_at?: string | null
          estimated_delivery?: string | null
          id?: never
          item_reference?: string | null
          parsed_at?: string | null
          po_id?: number | null
          po_line_item_id?: number | null
          po_number: string
          raw_email_id?: string | null
          ship_date?: string | null
          source_email_from?: string | null
          source_email_subject?: string | null
          status?: string | null
          tracking_number: string
        }
        Update: {
          carrier?: string | null
          created_at?: string | null
          estimated_delivery?: string | null
          id?: never
          item_reference?: string | null
          parsed_at?: string | null
          po_id?: number | null
          po_line_item_id?: number | null
          po_number?: string
          raw_email_id?: string | null
          ship_date?: string | null
          source_email_from?: string | null
          source_email_subject?: string | null
          status?: string | null
          tracking_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_shipment_tracking_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_shipment_tracking_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      po_shipments: {
        Row: {
          carrier: string | null
          created_at: string
          created_by: string | null
          delivered_date: string | null
          eta: string | null
          id: number
          notes: string | null
          po_id: number
          shipment_number: string | null
          shipped_date: string | null
          status: string
          tracking_number: string | null
          tracking_url: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          carrier?: string | null
          created_at?: string
          created_by?: string | null
          delivered_date?: string | null
          eta?: string | null
          id?: number
          notes?: string | null
          po_id: number
          shipment_number?: string | null
          shipped_date?: string | null
          status?: string
          tracking_number?: string | null
          tracking_url?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          carrier?: string | null
          created_at?: string
          created_by?: string | null
          delivered_date?: string | null
          eta?: string | null
          id?: number
          notes?: string | null
          po_id?: number
          shipment_number?: string | null
          shipped_date?: string | null
          status?: string
          tracking_number?: string | null
          tracking_url?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "po_shipments_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          bol_photo_key: string | null
          created_at: string | null
          created_by: string | null
          customer_id: number | null
          expected_delivery: string | null
          id: number
          job_id: number | null
          notes: string | null
          po_date: string | null
          po_number: string
          purchase_request_number: string | null
          qbo_bill_doc_number: string | null
          qbo_bill_id: string | null
          qbo_customer_id: string | null
          qbo_customer_name: string | null
          quote_pdf_key: string | null
          status: string | null
          store_name: string | null
          total_amount: number | null
          updated_at: string | null
          vendor_email: string | null
          vendor_id: number | null
          vendor_name: string
        }
        Insert: {
          bol_photo_key?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          expected_delivery?: string | null
          id?: never
          job_id?: number | null
          notes?: string | null
          po_date?: string | null
          po_number: string
          purchase_request_number?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          quote_pdf_key?: string | null
          status?: string | null
          store_name?: string | null
          total_amount?: number | null
          updated_at?: string | null
          vendor_email?: string | null
          vendor_id?: number | null
          vendor_name: string
        }
        Update: {
          bol_photo_key?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          expected_delivery?: string | null
          id?: never
          job_id?: number | null
          notes?: string | null
          po_date?: string | null
          po_number?: string
          purchase_request_number?: string | null
          qbo_bill_doc_number?: string | null
          qbo_bill_id?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          quote_pdf_key?: string | null
          status?: string | null
          store_name?: string | null
          total_amount?: number | null
          updated_at?: string | null
          vendor_email?: string | null
          vendor_id?: number | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_events: {
        Row: {
          at: string
          id: number
          key: string
          scope: string
        }
        Insert: {
          at?: string
          id?: number
          key: string
          scope: string
        }
        Update: {
          at?: string
          id?: number
          key?: string
          scope?: string
        }
        Relationships: []
      }
      stainless_equipment: {
        Row: {
          allocated_at: string | null
          allocated_by: string | null
          allocated_to_line_id: number | null
          category: string | null
          checkout_at: string | null
          checkout_order_id: number | null
          condition: string | null
          contract_item_id: number | null
          created_at: string | null
          customer_id: number | null
          deployed_at: string | null
          description: string | null
          id: number
          image_key: string | null
          installed_at: string | null
          installed_by: string | null
          is_proto: boolean | null
          item_no: string | null
          model: string | null
          notes: string | null
          photo_key: string | null
          po_id: number | null
          po_line_item_id: number | null
          po_number: string | null
          qty: number | null
          received_at: string | null
          received_by: string | null
          rent_rate: number | null
          requires_serial: boolean
          resq_code: string | null
          serial: string | null
          sf_job_id: string | null
          sf_job_number: string | null
          spec_sheet_key: string | null
          status: string | null
          store_order_id_allocated: number | null
          target_store: string | null
          unit_cost: number | null
          updated_at: string | null
          vendor: string | null
          warehouse_id: number | null
          warehouse_location: string | null
          weight_lbs: number | null
        }
        Insert: {
          allocated_at?: string | null
          allocated_by?: string | null
          allocated_to_line_id?: number | null
          category?: string | null
          checkout_at?: string | null
          checkout_order_id?: number | null
          condition?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          customer_id?: number | null
          deployed_at?: string | null
          description?: string | null
          id?: never
          image_key?: string | null
          installed_at?: string | null
          installed_by?: string | null
          is_proto?: boolean | null
          item_no?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          po_id?: number | null
          po_line_item_id?: number | null
          po_number?: string | null
          qty?: number | null
          received_at?: string | null
          received_by?: string | null
          rent_rate?: number | null
          requires_serial?: boolean
          resq_code?: string | null
          serial?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          spec_sheet_key?: string | null
          status?: string | null
          store_order_id_allocated?: number | null
          target_store?: string | null
          unit_cost?: number | null
          updated_at?: string | null
          vendor?: string | null
          warehouse_id?: number | null
          warehouse_location?: string | null
          weight_lbs?: number | null
        }
        Update: {
          allocated_at?: string | null
          allocated_by?: string | null
          allocated_to_line_id?: number | null
          category?: string | null
          checkout_at?: string | null
          checkout_order_id?: number | null
          condition?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          customer_id?: number | null
          deployed_at?: string | null
          description?: string | null
          id?: never
          image_key?: string | null
          installed_at?: string | null
          installed_by?: string | null
          is_proto?: boolean | null
          item_no?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          po_id?: number | null
          po_line_item_id?: number | null
          po_number?: string | null
          qty?: number | null
          received_at?: string | null
          received_by?: string | null
          rent_rate?: number | null
          requires_serial?: boolean
          resq_code?: string | null
          serial?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          spec_sheet_key?: string | null
          status?: string | null
          store_order_id_allocated?: number | null
          target_store?: string | null
          unit_cost?: number | null
          updated_at?: string | null
          vendor?: string | null
          warehouse_id?: number | null
          warehouse_location?: string | null
          weight_lbs?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "stainless_equipment_allocated_to_line_id_fkey"
            columns: ["allocated_to_line_id"]
            isOneToOne: false
            referencedRelation: "store_order_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_contract_item_id_fkey"
            columns: ["contract_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_store_order_id_allocated_fkey"
            columns: ["store_order_id_allocated"]
            isOneToOne: false
            referencedRelation: "store_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stainless_equipment_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "warehouses"
            referencedColumns: ["id"]
          },
        ]
      }
      store_order_approvals: {
        Row: {
          approver_email: string
          attached_file_keys: Json | null
          created_at: string | null
          created_by: string | null
          customer_id: number | null
          decline_reason: string | null
          expires_at: string | null
          id: number
          intro_note: string | null
          ip_address: string | null
          responded_at: string | null
          sent_at: string | null
          signature_base64: string | null
          signature_key: string | null
          signature_sha256: string | null
          signer_initials: string | null
          signer_name: string | null
          status: string
          store_order_id: number
          token: string
          user_agent: string | null
        }
        Insert: {
          approver_email: string
          attached_file_keys?: Json | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          decline_reason?: string | null
          expires_at?: string | null
          id?: number
          intro_note?: string | null
          ip_address?: string | null
          responded_at?: string | null
          sent_at?: string | null
          signature_base64?: string | null
          signature_key?: string | null
          signature_sha256?: string | null
          signer_initials?: string | null
          signer_name?: string | null
          status?: string
          store_order_id: number
          token: string
          user_agent?: string | null
        }
        Update: {
          approver_email?: string
          attached_file_keys?: Json | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          decline_reason?: string | null
          expires_at?: string | null
          id?: number
          intro_note?: string | null
          ip_address?: string | null
          responded_at?: string | null
          sent_at?: string | null
          signature_base64?: string | null
          signature_key?: string | null
          signature_sha256?: string | null
          signer_initials?: string | null
          signer_name?: string | null
          status?: string
          store_order_id?: number
          token?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_order_approvals_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_order_approvals_store_order_id_fkey"
            columns: ["store_order_id"]
            isOneToOne: false
            referencedRelation: "store_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      store_order_items: {
        Row: {
          allocated_qty: number | null
          category: string | null
          contract_item_id: number | null
          created_at: string | null
          description: string | null
          id: number
          installed_qty: number | null
          manufacturer: string | null
          model: string | null
          name: string
          qbo_line_id: string | null
          qty: number
          shipped_qty: number | null
          sku: string | null
          sort_order: number | null
          store_order_id: number | null
          taxable: boolean
          unit_cost: number | null
          unit_price: number
        }
        Insert: {
          allocated_qty?: number | null
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description?: string | null
          id?: never
          installed_qty?: number | null
          manufacturer?: string | null
          model?: string | null
          name: string
          qbo_line_id?: string | null
          qty?: number
          shipped_qty?: number | null
          sku?: string | null
          sort_order?: number | null
          store_order_id?: number | null
          taxable?: boolean
          unit_cost?: number | null
          unit_price: number
        }
        Update: {
          allocated_qty?: number | null
          category?: string | null
          contract_item_id?: number | null
          created_at?: string | null
          description?: string | null
          id?: never
          installed_qty?: number | null
          manufacturer?: string | null
          model?: string | null
          name?: string
          qbo_line_id?: string | null
          qty?: number
          shipped_qty?: number | null
          sku?: string | null
          sort_order?: number | null
          store_order_id?: number | null
          taxable?: boolean
          unit_cost?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "fk_soi_contract_item"
            columns: ["contract_item_id"]
            isOneToOne: false
            referencedRelation: "contract_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_order_items_store_order_id_fkey"
            columns: ["store_order_id"]
            isOneToOne: false
            referencedRelation: "store_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      store_orders: {
        Row: {
          closed_at: string | null
          contract_id: number | null
          created_at: string | null
          created_by: string | null
          customer_id: number | null
          id: number
          job_id: number | null
          kind: string
          notes: string | null
          order_number: string
          qbo_invoice_id: string | null
          qbo_invoice_number: string | null
          sf_job_id: string | null
          sf_job_number: string | null
          status: string | null
          subtotal: number | null
          target_store: string
          tax_amount: number | null
          tax_rate: number | null
          total_amount: number | null
        }
        Insert: {
          closed_at?: string | null
          contract_id?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          id?: never
          job_id?: number | null
          kind?: string
          notes?: string | null
          order_number: string
          qbo_invoice_id?: string | null
          qbo_invoice_number?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          status?: string | null
          subtotal?: number | null
          target_store: string
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount?: number | null
        }
        Update: {
          closed_at?: string | null
          contract_id?: number | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: number | null
          id?: never
          job_id?: number | null
          kind?: string
          notes?: string | null
          order_number?: string
          qbo_invoice_id?: string | null
          qbo_invoice_number?: string | null
          sf_job_id?: string | null
          sf_job_number?: string | null
          status?: string | null
          subtotal?: number | null
          target_store?: string
          tax_amount?: number | null
          tax_rate?: number | null
          total_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_store_orders_contract"
            columns: ["contract_id"]
            isOneToOne: false
            referencedRelation: "customer_contracts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      store_schedule: {
        Row: {
          address: string | null
          city: string | null
          construction_start: string | null
          customer_id: number | null
          extra: Json | null
          grand_opening: string | null
          id: number
          install_dates: string | null
          location_type: string
          pct_complete: string | null
          phase: string | null
          qbo_customer_id: string | null
          qbo_customer_name: string | null
          state: string | null
          status: string | null
          store_name: string
          suite: string | null
          timeline: string | null
          updated_at: string | null
          zip: string | null
        }
        Insert: {
          address?: string | null
          city?: string | null
          construction_start?: string | null
          customer_id?: number | null
          extra?: Json | null
          grand_opening?: string | null
          id?: never
          install_dates?: string | null
          location_type?: string
          pct_complete?: string | null
          phase?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          state?: string | null
          status?: string | null
          store_name: string
          suite?: string | null
          timeline?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Update: {
          address?: string | null
          city?: string | null
          construction_start?: string | null
          customer_id?: number | null
          extra?: Json | null
          grand_opening?: string | null
          id?: never
          install_dates?: string | null
          location_type?: string
          pct_complete?: string | null
          phase?: string | null
          qbo_customer_id?: string | null
          qbo_customer_name?: string | null
          state?: string | null
          status?: string | null
          store_name?: string
          suite?: string | null
          timeline?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_schedule_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_locations: {
        Row: {
          active: boolean
          address: string | null
          city: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          customer_id: number | null
          id: number
          name: string
          notes: string | null
          parent_id: number | null
          state: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          active?: boolean
          address?: string | null
          city?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id?: number | null
          id?: number
          name: string
          notes?: string | null
          parent_id?: number | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          active?: boolean
          address?: string | null
          city?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          customer_id?: number | null
          id?: number
          name?: string
          notes?: string | null
          parent_id?: number | null
          state?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sub_locations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sub_locations_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "store_schedule"
            referencedColumns: ["id"]
          },
        ]
      }
      tracker_checklist: {
        Row: {
          category: string
          completed_at: string | null
          completed_by: string | null
          created_at: string
          details: string | null
          id: number
          is_complete: boolean
          job_id: number
          label: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          details?: string | null
          id?: number
          is_complete?: boolean
          job_id: number
          label: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category?: string
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          details?: string | null
          id?: number
          is_complete?: boolean
          job_id?: number
          label?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracker_checklist_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      tracker_share_tokens: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: number
          job_id: number
          label: string | null
          last_used_at: string | null
          permissions: string
          revoked_at: string | null
          token: string
          use_count: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: number
          job_id: number
          label?: string | null
          last_used_at?: string | null
          permissions?: string
          revoked_at?: string | null
          token: string
          use_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: number
          job_id?: number
          label?: string | null
          last_used_at?: string | null
          permissions?: string
          revoked_at?: string | null
          token?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "tracker_share_tokens_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      tracking_line_items: {
        Row: {
          created_at: string | null
          id: number
          po_line_item_id: number | null
          qty_shipped: number | null
          tracking_id: number | null
        }
        Insert: {
          created_at?: string | null
          id?: never
          po_line_item_id?: number | null
          qty_shipped?: number | null
          tracking_id?: number | null
        }
        Update: {
          created_at?: string | null
          id?: never
          po_line_item_id?: number | null
          qty_shipped?: number | null
          tracking_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tracking_line_items_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tracking_line_items_tracking_id_fkey"
            columns: ["tracking_id"]
            isOneToOne: false
            referencedRelation: "po_shipment_tracking"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          active: boolean | null
          address: string | null
          contact_name: string | null
          created_at: string | null
          default_terms: string | null
          email: string | null
          id: number
          name: string
          notes: string | null
          phone: string | null
          website: string | null
        }
        Insert: {
          active?: boolean | null
          address?: string | null
          contact_name?: string | null
          created_at?: string | null
          default_terms?: string | null
          email?: string | null
          id?: never
          name: string
          notes?: string | null
          phone?: string | null
          website?: string | null
        }
        Update: {
          active?: boolean | null
          address?: string | null
          contact_name?: string | null
          created_at?: string | null
          default_terms?: string | null
          email?: string | null
          id?: never
          name?: string
          notes?: string | null
          phone?: string | null
          website?: string | null
        }
        Relationships: []
      }
      warehouse_inventory: {
        Row: {
          category: string | null
          condition: string | null
          created_at: string | null
          deployed_at: string | null
          description: string | null
          id: number
          location: string | null
          model: string | null
          notes: string | null
          photo_key: string | null
          po_line_item_id: number | null
          po_number: string | null
          received_at: string | null
          received_by: string | null
          serial: string | null
          sf_job_id: string | null
          store_name: string | null
          unit_cost: number | null
          vendor: string | null
        }
        Insert: {
          category?: string | null
          condition?: string | null
          created_at?: string | null
          deployed_at?: string | null
          description?: string | null
          id?: number
          location?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          po_line_item_id?: number | null
          po_number?: string | null
          received_at?: string | null
          received_by?: string | null
          serial?: string | null
          sf_job_id?: string | null
          store_name?: string | null
          unit_cost?: number | null
          vendor?: string | null
        }
        Update: {
          category?: string | null
          condition?: string | null
          created_at?: string | null
          deployed_at?: string | null
          description?: string | null
          id?: number
          location?: string | null
          model?: string | null
          notes?: string | null
          photo_key?: string | null
          po_line_item_id?: number | null
          po_number?: string | null
          received_at?: string | null
          received_by?: string | null
          serial?: string | null
          sf_job_id?: string | null
          store_name?: string | null
          unit_cost?: number | null
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "warehouse_inventory_po_line_item_id_fkey"
            columns: ["po_line_item_id"]
            isOneToOne: false
            referencedRelation: "po_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      warehouses: {
        Row: {
          active: boolean | null
          address: string | null
          city: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string | null
          id: number
          name: string
          notes: string | null
          ownership: string
          state: string | null
          updated_at: string | null
          zip: string | null
        }
        Insert: {
          active?: boolean | null
          address?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: never
          name: string
          notes?: string | null
          ownership?: string
          state?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Update: {
          active?: boolean | null
          address?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string | null
          id?: never
          name?: string
          notes?: string | null
          ownership?: string
          state?: string | null
          updated_at?: string | null
          zip?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_knowledge_chunks:
        | {
            Args: { p_customer_id: number; p_k?: number; p_query: string }
            Returns: {
              chunk_index: number
              content: string
              file_id: number
              file_name: string
              similarity: number
            }[]
          }
        | {
            Args: {
              p_customer_id: number
              p_job_id?: number
              p_k?: number
              p_query: string
            }
            Returns: {
              chunk_index: number
              content: string
              file_id: number
              file_name: string
              similarity: number
            }[]
          }
      qbo_token_claim_refresh: {
        Args: {
          p_lease_seconds?: number
          p_min_ttl_seconds?: number
          p_realm_id: string
        }
        Returns: {
          cached_access_token: string
          cached_refresh_token: string
          lease_acquired: boolean
          must_refresh: boolean
          reason: string
        }[]
      }
      qbo_token_persist: {
        Args: {
          p_access_expires: string
          p_access_token: string
          p_realm_id: string
          p_refresh_expires: string
          p_refresh_token: string
          p_refreshed_by?: string
        }
        Returns: undefined
      }
      qbo_token_release_failed: {
        Args: { p_error: string; p_realm_id: string }
        Returns: undefined
      }
      recompute_po_line_qty_shipped: {
        Args: { p_line_id: number }
        Returns: undefined
      }
      seed_tracker_checklist: { Args: { p_job_id: number }; Returns: undefined }
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

