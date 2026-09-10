export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      auction_documents: {
        Row: {
          created_at: string;
          document_type: string | null;
          document_url: string;
          extraction_status: string | null;
          id: string;
          label: string | null;
          source_url: string;
        };
        Insert: {
          created_at?: string;
          document_type?: string | null;
          document_url: string;
          extraction_status?: string | null;
          id?: string;
          label?: string | null;
          source_url: string;
        };
        Update: {
          created_at?: string;
          document_type?: string | null;
          document_url?: string;
          extraction_status?: string | null;
          id?: string;
          label?: string | null;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_cadastre_parcels: {
        Row: {
          centroid_lat: number | null;
          centroid_lng: number | null;
          city: string | null;
          code_insee: string | null;
          confidence: number;
          created_at: string;
          department: string | null;
          geometry_geojson: Json;
          id: string;
          match_kind: string;
          parcel_id: string | null;
          parcel_key: string;
          parcel_number: string | null;
          raw_payload: Json;
          section: string | null;
          source_api: string;
          source_api_url: string | null;
          source_url: string;
          surface_m2: number | null;
          updated_at: string;
        };
        Insert: {
          centroid_lat?: number | null;
          centroid_lng?: number | null;
          city?: string | null;
          code_insee?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          geometry_geojson?: Json;
          id?: string;
          match_kind?: string;
          parcel_id?: string | null;
          parcel_key: string;
          parcel_number?: string | null;
          raw_payload?: Json;
          section?: string | null;
          source_api?: string;
          source_api_url?: string | null;
          source_url: string;
          surface_m2?: number | null;
          updated_at?: string;
        };
        Update: {
          centroid_lat?: number | null;
          centroid_lng?: number | null;
          city?: string | null;
          code_insee?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          geometry_geojson?: Json;
          id?: string;
          match_kind?: string;
          parcel_id?: string | null;
          parcel_key?: string;
          parcel_number?: string | null;
          raw_payload?: Json;
          section?: string | null;
          source_api?: string;
          source_api_url?: string | null;
          source_url?: string;
          surface_m2?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_cadastre_parcels_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_dpe_diagnostics: {
        Row: {
          address: string | null;
          ban_score: number | null;
          city: string | null;
          confidence: number;
          created_at: string;
          department: string | null;
          diagnostic_number: string;
          dpe_class: string | null;
          emissions_kg_co2_m2_year: number | null;
          energy_consumption_kwh_m2_year: number | null;
          established_at: string | null;
          ges_class: string | null;
          id: string;
          insee_code: string | null;
          last_modified_at: string | null;
          latitude: number | null;
          location: unknown | null;
          longitude: number | null;
          match_kind: string;
          postal_code: string | null;
          property_type: string | null;
          raw_payload: Json;
          source_api: string;
          source_api_url: string | null;
          source_url: string;
          surface_m2: number | null;
          updated_at: string;
          valid_until: string | null;
        };
        Insert: {
          address?: string | null;
          ban_score?: number | null;
          city?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          diagnostic_number: string;
          dpe_class?: string | null;
          emissions_kg_co2_m2_year?: number | null;
          energy_consumption_kwh_m2_year?: number | null;
          established_at?: string | null;
          ges_class?: string | null;
          id?: string;
          insee_code?: string | null;
          last_modified_at?: string | null;
          latitude?: number | null;
          location?: unknown | null;
          longitude?: number | null;
          match_kind?: string;
          postal_code?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          source_api?: string;
          source_api_url?: string | null;
          source_url: string;
          surface_m2?: number | null;
          updated_at?: string;
          valid_until?: string | null;
        };
        Update: {
          address?: string | null;
          ban_score?: number | null;
          city?: string | null;
          confidence?: number;
          created_at?: string;
          department?: string | null;
          diagnostic_number?: string;
          dpe_class?: string | null;
          emissions_kg_co2_m2_year?: number | null;
          energy_consumption_kwh_m2_year?: number | null;
          established_at?: string | null;
          ges_class?: string | null;
          id?: string;
          insee_code?: string | null;
          last_modified_at?: string | null;
          latitude?: number | null;
          location?: unknown | null;
          longitude?: number | null;
          match_kind?: string;
          postal_code?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          source_api?: string;
          source_api_url?: string | null;
          source_url?: string;
          surface_m2?: number | null;
          updated_at?: string;
          valid_until?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_dpe_diagnostics_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_urban_planning_signals: {
        Row: {
          action: string | null;
          confidence: number;
          created_at: string;
          detector: string;
          detector_version: string;
          document_label: string | null;
          document_type: string | null;
          document_url: string | null;
          excerpt: string | null;
          id: string;
          label: string;
          page_number: number | null;
          priority: string;
          raw_payload: Json;
          signal_key: string;
          signal_kind: string;
          source_kind: string;
          source_name: string | null;
          source_url: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          action?: string | null;
          confidence?: number;
          created_at?: string;
          detector?: string;
          detector_version?: string;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          label: string;
          page_number?: number | null;
          priority?: string;
          raw_payload?: Json;
          signal_key: string;
          signal_kind: string;
          source_kind?: string;
          source_name?: string | null;
          source_url: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          action?: string | null;
          confidence?: number;
          created_at?: string;
          detector?: string;
          detector_version?: string;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          label?: string;
          page_number?: number | null;
          priority?: string;
          raw_payload?: Json;
          signal_key?: string;
          signal_kind?: string;
          source_kind?: string;
          source_name?: string | null;
          source_url?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "auction_urban_planning_signals_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
        ];
      };
      properties: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string;
          department: string | null;
          description: string | null;
          external_id: string | null;
          first_seen_at: string;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          habitable_surface_m2: number | null;
          id: string;
          land_surface_m2: number | null;
          last_seen_at: string;
          latitude: number | null;
          location: unknown | null;
          longitude: number | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          raw_payload: Json;
          rooms_count: number | null;
          source_name: string;
          source_url: string;
          source_urls: Json;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_m2: number | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          description?: string | null;
          external_id?: string | null;
          first_seen_at?: string;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          habitable_surface_m2?: number | null;
          id?: string;
          land_surface_m2?: number | null;
          last_seen_at?: string;
          latitude?: number | null;
          location?: unknown | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          rooms_count?: number | null;
          source_name: string;
          source_url: string;
          source_urls?: Json;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          description?: string | null;
          external_id?: string | null;
          first_seen_at?: string;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          habitable_surface_m2?: number | null;
          id?: string;
          land_surface_m2?: number | null;
          last_seen_at?: string;
          latitude?: number | null;
          location?: unknown | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          raw_payload?: Json;
          rooms_count?: number | null;
          source_name?: string;
          source_url?: string;
          source_urls?: Json;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_m2?: number | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "properties_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
        ];
      };
      judicial_sales: {
        Row: {
          adjudication_price_eur: number | null;
          content_hash: string | null;
          created_at: string;
          documents_count: number;
          external_id: string | null;
          first_seen_at: string;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          last_run_id: string | null;
          last_seen_at: string;
          primary_source: string | null;
          property_source_url: string;
          quality_flags: Json;
          raw_payload: Json;
          sale_date: string | null;
          score_confidence: number | null;
          score_factors: Json;
          score_version: string | null;
          source_lawyer_contact: string | null;
          source_lawyer_name: string | null;
          source_name: string;
          source_url: string;
          source_urls: Json;
          starting_price_eur: number | null;
          status: string;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string;
          visit_dates: Json;
        };
        Insert: {
          adjudication_price_eur?: number | null;
          content_hash?: string | null;
          created_at?: string;
          documents_count?: number;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          last_run_id?: string | null;
          last_seen_at?: string;
          primary_source?: string | null;
          property_source_url: string;
          quality_flags?: Json;
          raw_payload?: Json;
          sale_date?: string | null;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_lawyer_contact?: string | null;
          source_lawyer_name?: string | null;
          source_name: string;
          source_url: string;
          source_urls?: Json;
          starting_price_eur?: number | null;
          status?: string;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
          visit_dates?: Json;
        };
        Update: {
          adjudication_price_eur?: number | null;
          content_hash?: string | null;
          created_at?: string;
          documents_count?: number;
          external_id?: string | null;
          first_seen_at?: string;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          last_run_id?: string | null;
          last_seen_at?: string;
          primary_source?: string | null;
          property_source_url?: string;
          quality_flags?: Json;
          raw_payload?: Json;
          sale_date?: string | null;
          score_confidence?: number | null;
          score_factors?: Json;
          score_version?: string | null;
          source_lawyer_contact?: string | null;
          source_lawyer_name?: string | null;
          source_name?: string;
          source_url?: string;
          source_urls?: Json;
          starting_price_eur?: number | null;
          status?: string;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
          visit_dates?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "judicial_sales_property_source_url_fkey";
            columns: ["property_source_url"];
            isOneToOne: false;
            referencedRelation: "properties";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
          {
            foreignKeyName: "judicial_sales_tribunal_code_fkey";
            columns: ["tribunal_code"];
            isOneToOne: false;
            referencedRelation: "tribunals";
            referencedColumns: ["code"];
          },
        ];
      };
      commercial_acceptances: {
        Row: {
          accepted_at: string;
          amount_cents: number;
          archived_until: string | null;
          checkout_created_at: string | null;
          checkout_session_id: string | null;
          currency: string;
          evidence: Json;
          id: string;
          immediate_performance_requested: boolean;
          offer_code: string;
          payment_obligation_acknowledged: boolean;
          privacy_sha256: string;
          privacy_version: string;
          purpose: string;
          request_id: string | null;
          requester_email_hash: string | null;
          terms_accepted: boolean;
          terms_sha256: string;
          terms_version: string;
          user_agent_hash: string | null;
          user_id: string | null;
          withdrawal_information_acknowledged: boolean;
        };
        Insert: {
          accepted_at?: string;
          amount_cents: number;
          archived_until?: string | null;
          checkout_created_at?: string | null;
          checkout_session_id?: string | null;
          currency: string;
          evidence?: Json;
          id?: string;
          immediate_performance_requested: boolean;
          offer_code: string;
          payment_obligation_acknowledged: boolean;
          privacy_sha256: string;
          privacy_version: string;
          purpose?: string;
          request_id?: string | null;
          requester_email_hash?: string | null;
          terms_accepted: boolean;
          terms_sha256: string;
          terms_version: string;
          user_agent_hash?: string | null;
          user_id?: string | null;
          withdrawal_information_acknowledged: boolean;
        };
        Update: {
          accepted_at?: string;
          amount_cents?: number;
          archived_until?: string | null;
          checkout_created_at?: string | null;
          checkout_session_id?: string | null;
          currency?: string;
          evidence?: Json;
          id?: string;
          immediate_performance_requested?: boolean;
          offer_code?: string;
          payment_obligation_acknowledged?: boolean;
          privacy_sha256?: string;
          privacy_version?: string;
          purpose?: string;
          request_id?: string | null;
          requester_email_hash?: string | null;
          terms_accepted?: boolean;
          terms_sha256?: string;
          terms_version?: string;
          user_agent_hash?: string | null;
          user_id?: string | null;
          withdrawal_information_acknowledged?: boolean;
        };
        Relationships: [];
      };
      commercial_confirmation_deliveries: {
        Row: {
          acceptance_id: string;
          attempt_count: number;
          checkout_session_id: string;
          created_at: string;
          error_message: string | null;
          id: string;
          paid_at: string;
          provider_message_id: string | null;
          recipient_hash: string | null;
          sent_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          acceptance_id: string;
          attempt_count?: number;
          checkout_session_id: string;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          paid_at: string;
          provider_message_id?: string | null;
          recipient_hash?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          acceptance_id?: string;
          attempt_count?: number;
          checkout_session_id?: string;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          paid_at?: string;
          provider_message_id?: string | null;
          recipient_hash?: string | null;
          sent_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commercial_confirmation_deliveries_acceptance_id_fkey";
            columns: ["acceptance_id"];
            isOneToOne: true;
            referencedRelation: "commercial_acceptances";
            referencedColumns: ["id"];
          },
        ];
      };
      data_subject_requests: {
        Row: {
          acknowledged_at: string;
          completed_at: string | null;
          due_at: string;
          id: string;
          identity_status: string;
          message: string | null;
          metadata: Json;
          operator_notes: string | null;
          request_type: string;
          requester_email: string;
          resolution_code: string | null;
          status: string;
          submitted_at: string;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          acknowledged_at?: string;
          completed_at?: string | null;
          due_at?: string;
          id?: string;
          identity_status?: string;
          message?: string | null;
          metadata?: Json;
          operator_notes?: string | null;
          request_type: string;
          requester_email: string;
          resolution_code?: string | null;
          status?: string;
          submitted_at?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          acknowledged_at?: string;
          completed_at?: string | null;
          due_at?: string;
          id?: string;
          identity_status?: string;
          message?: string | null;
          metadata?: Json;
          operator_notes?: string | null;
          request_type?: string;
          requester_email?: string;
          resolution_code?: string | null;
          status?: string;
          submitted_at?: string;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [];
      };
      data_refresh_requests: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_message: string | null;
          id: string;
          priority: number;
          request_kind: "cadastre" | "dpe" | "full";
          requested_payload: Json;
          result_summary: Json;
          sale_id: string;
          source_url: string;
          started_at: string | null;
          status: "queued" | "running" | "completed" | "failed" | "cancelled";
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          priority?: number;
          request_kind: "cadastre" | "dpe" | "full";
          requested_payload?: Json;
          result_summary?: Json;
          sale_id: string;
          source_url: string;
          started_at?: string | null;
          status?: "queued" | "running" | "completed" | "failed" | "cancelled";
          updated_at?: string;
          user_id: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          id?: string;
          priority?: number;
          request_kind?: "cadastre" | "dpe" | "full";
          requested_payload?: Json;
          result_summary?: Json;
          sale_id?: string;
          source_url?: string;
          started_at?: string | null;
          status?: "queued" | "running" | "completed" | "failed" | "cancelled";
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "data_refresh_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "data_refresh_requests_source_url_fkey";
            columns: ["source_url"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["source_url"];
          },
        ];
      };
      auction_risks: {
        Row: {
          created_at: string;
          evidence: string | null;
          id: string;
          risk_label: string | null;
          risk_type: string | null;
          severity: number | null;
          source_url: string;
        };
        Insert: {
          created_at?: string;
          evidence?: string | null;
          id?: string;
          risk_label?: string | null;
          risk_type?: string | null;
          severity?: number | null;
          source_url: string;
        };
        Update: {
          created_at?: string;
          evidence?: string | null;
          id?: string;
          risk_label?: string | null;
          risk_type?: string | null;
          severity?: number | null;
          source_url?: string;
        };
        Relationships: [];
      };
      auction_sale_market_estimates: {
        Row: {
          actionable: boolean;
          attempt_count: number;
          auction_sale_id: string;
          comparable_count: number;
          computed_at: string | null;
          confidence_score: number | null;
          created_at: string;
          engine_kind: "comparable_ensemble" | "hybrid_lightgbm" | null;
          engine_version: string | null;
          error_message: string | null;
          estimate: Json | null;
          input_fingerprint: string;
          last_error_code: string | null;
          last_finished_at: string | null;
          last_started_at: string | null;
          model_version: string | null;
          model_version_id: string | null;
          next_refresh_at: string;
          priority: number;
          refresh_reason: string;
          requested_at: string | null;
          segment: "apartment" | "house" | "building" | "commercial" | "land" | "parking" | null;
          source_updated_at: string | null;
          status: "pending" | "processing" | "ready" | "insufficient_data" | "failed";
          updated_at: string;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        };
        Insert: {
          actionable?: boolean;
          attempt_count?: number;
          auction_sale_id: string;
          comparable_count?: number;
          computed_at?: string | null;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: "comparable_ensemble" | "hybrid_lightgbm" | null;
          engine_version?: string | null;
          error_message?: string | null;
          estimate?: Json | null;
          input_fingerprint: string;
          last_error_code?: string | null;
          last_finished_at?: string | null;
          last_started_at?: string | null;
          model_version?: string | null;
          model_version_id?: string | null;
          next_refresh_at?: string;
          priority?: number;
          refresh_reason?: string;
          requested_at?: string | null;
          segment?: "apartment" | "house" | "building" | "commercial" | "land" | "parking" | null;
          source_updated_at?: string | null;
          status?: "pending" | "processing" | "ready" | "insufficient_data" | "failed";
          updated_at?: string;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Update: {
          actionable?: boolean;
          attempt_count?: number;
          auction_sale_id?: string;
          comparable_count?: number;
          computed_at?: string | null;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: "comparable_ensemble" | "hybrid_lightgbm" | null;
          engine_version?: string | null;
          error_message?: string | null;
          estimate?: Json | null;
          input_fingerprint?: string;
          last_error_code?: string | null;
          last_finished_at?: string | null;
          last_started_at?: string | null;
          model_version?: string | null;
          model_version_id?: string | null;
          next_refresh_at?: string;
          priority?: number;
          refresh_reason?: string;
          requested_at?: string | null;
          segment?: "apartment" | "house" | "building" | "commercial" | "land" | "parking" | null;
          source_updated_at?: string | null;
          status?: "pending" | "processing" | "ready" | "insufficient_data" | "failed";
          updated_at?: string;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "auction_sale_market_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: true;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "auction_sale_market_estimates_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "valuation_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      auction_sales: {
        Row: {
          address: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string;
          dedupe_confidence: string | null;
          department: string | null;
          documents: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          raw_payload: Json | null;
          risk_notes: string | null;
          rooms_count: number | null;
          sale_date: string | null;
          sale_legal_framework: string;
          sale_procedure: Json;
          sale_venue_type: string;
          sale_verification_status: string;
          score_version: string | null;
          source_name: string | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_scope: string | null;
          surface_source: string | null;
          surface_m2: number | null;
          title: string | null;
          tribunal: string | null;
          tribunal_code: string | null;
          updated_at: string;
        };
        Insert: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          dedupe_confidence?: string | null;
          department?: string | null;
          documents?: Json | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          raw_payload?: Json | null;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          sale_legal_framework?: string;
          sale_procedure?: Json;
          sale_venue_type?: string;
          sale_verification_status?: string;
          score_version?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          surface_m2?: number | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
        };
        Update: {
          address?: string | null;
          app_surface_kind?: string | null;
          app_surface_m2?: number | null;
          bathrooms_count?: number | null;
          bedrooms_count?: number | null;
          carrez_surface_m2?: number | null;
          city?: string | null;
          created_at?: string;
          dedupe_confidence?: string | null;
          department?: string | null;
          documents?: Json | null;
          habitable_surface_m2?: number | null;
          has_air_conditioning?: boolean | null;
          has_double_glazing?: boolean | null;
          has_garage?: boolean | null;
          has_garden?: boolean | null;
          has_pool?: boolean | null;
          has_terrace?: boolean | null;
          id?: string;
          investment_score?: number | null;
          investment_summary?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          occupancy_status?: string | null;
          parking_count?: number | null;
          postal_code?: string | null;
          primary_source?: string | null;
          property_type?: string | null;
          quality_flags?: Json | null;
          raw_payload?: Json | null;
          risk_notes?: string | null;
          rooms_count?: number | null;
          sale_date?: string | null;
          sale_legal_framework?: string;
          sale_procedure?: Json;
          sale_venue_type?: string;
          sale_verification_status?: string;
          score_version?: string | null;
          source_name?: string | null;
          source_url?: string | null;
          source_urls?: Json | null;
          starting_price_eur?: number | null;
          status?: string | null;
          surface_confidence?: number | null;
          surface_evidence?: string | null;
          surface_scope?: string | null;
          surface_source?: string | null;
          surface_m2?: number | null;
          title?: string | null;
          tribunal?: string | null;
          tribunal_code?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      dvf_import_batches: {
        Row: {
          completed_at: string | null;
          created_at: string;
          error_message: string | null;
          file_name: string | null;
          id: string;
          imported_rows: number;
          metadata: Json;
          period_end: string | null;
          period_start: string | null;
          source: string;
          source_url: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          metadata?: Json;
          period_end?: string | null;
          period_start?: string | null;
          source?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          error_message?: string | null;
          file_name?: string | null;
          id?: string;
          imported_rows?: number;
          metadata?: Json;
          period_end?: string | null;
          period_start?: string | null;
          source?: string;
          source_url?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      dvf_market_statistics: {
        Row: {
          geography_code: string;
          geography_label: string;
          geography_level: "department" | "epci" | "commune";
          imported_at: string;
          mean_price_per_m2: number | null;
          median_price_per_m2: number | null;
          parent_code: string | null;
          sales_count: number;
          segment: "apartment" | "house" | "residential" | "commercial";
          source_updated_at: string | null;
          source_url: string;
        };
        Insert: {
          geography_code: string;
          geography_label: string;
          geography_level: "department" | "epci" | "commune";
          imported_at?: string;
          mean_price_per_m2?: number | null;
          median_price_per_m2?: number | null;
          parent_code?: string | null;
          sales_count: number;
          segment: "apartment" | "house" | "residential" | "commercial";
          source_updated_at?: string | null;
          source_url: string;
        };
        Update: {
          geography_code?: string;
          geography_label?: string;
          geography_level?: "department" | "epci" | "commune";
          imported_at?: string;
          mean_price_per_m2?: number | null;
          median_price_per_m2?: number | null;
          parent_code?: string | null;
          sales_count?: number;
          segment?: "apartment" | "house" | "residential" | "commercial";
          source_updated_at?: string | null;
          source_url?: string;
        };
        Relationships: [];
      };
      dvf_transactions: {
        Row: {
          address: string | null;
          built_surface_m2: number | null;
          city: string | null;
          department: string | null;
          dvf_property_type_code: string | null;
          id: string;
          import_batch_id: string | null;
          insee_code: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          longitude: number | null;
          lots_count: number | null;
          mutation_nature: string | null;
          parcel_id: string | null;
          postal_code: string | null;
          price_per_m2: number | null;
          property_type: string | null;
          rooms_count: number | null;
          sale_date: string;
          source: string;
          source_mutation_id: string;
          total_price_eur: number;
        };
        Insert: {
          address?: string | null;
          built_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          dvf_property_type_code?: string | null;
          id?: string;
          import_batch_id?: string | null;
          insee_code?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          lots_count?: number | null;
          mutation_nature?: string | null;
          parcel_id?: string | null;
          postal_code?: string | null;
          price_per_m2?: number | null;
          property_type?: string | null;
          rooms_count?: number | null;
          sale_date: string;
          source?: string;
          source_mutation_id: string;
          total_price_eur: number;
        };
        Update: {
          address?: string | null;
          built_surface_m2?: number | null;
          city?: string | null;
          department?: string | null;
          dvf_property_type_code?: string | null;
          id?: string;
          import_batch_id?: string | null;
          insee_code?: string | null;
          land_surface_m2?: number | null;
          latitude?: number | null;
          longitude?: number | null;
          lots_count?: number | null;
          mutation_nature?: string | null;
          parcel_id?: string | null;
          postal_code?: string | null;
          price_per_m2?: number | null;
          property_type?: string | null;
          rooms_count?: number | null;
          sale_date?: string;
          source?: string;
          source_mutation_id?: string;
          total_price_eur?: number;
        };
        Relationships: [
          {
            foreignKeyName: "dvf_transactions_import_batch_id_fkey";
            columns: ["import_batch_id"];
            isOneToOne: false;
            referencedRelation: "dvf_import_batches";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_estimate_attempts: {
        Row: {
          actionable: boolean | null;
          attempt_number: number;
          auction_sale_id: string;
          comparable_count: number | null;
          confidence_score: number | null;
          created_at: string;
          details: Json;
          engine_kind: string | null;
          error_code: string | null;
          error_message: string | null;
          id: string;
          input_fingerprint: string;
          latency_ms: number;
          outcome: "ready" | "insufficient_data" | "failed" | "superseded";
          request_source: string;
          segment: string | null;
        };
        Insert: {
          actionable?: boolean | null;
          attempt_number: number;
          auction_sale_id: string;
          comparable_count?: number | null;
          confidence_score?: number | null;
          created_at?: string;
          details?: Json;
          engine_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          input_fingerprint: string;
          latency_ms: number;
          outcome: "ready" | "insufficient_data" | "failed" | "superseded";
          request_source: string;
          segment?: string | null;
        };
        Update: {
          actionable?: boolean | null;
          attempt_number?: number;
          auction_sale_id?: string;
          comparable_count?: number | null;
          confidence_score?: number | null;
          created_at?: string;
          details?: Json;
          engine_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          input_fingerprint?: string;
          latency_ms?: number;
          outcome?: "ready" | "insufficient_data" | "failed" | "superseded";
          request_source?: string;
          segment?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "valuation_estimate_attempts_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_estimates: {
        Row: {
          actionable: boolean;
          auction_sale_id: string | null;
          comparable_count: number;
          confidence_score: number | null;
          created_at: string;
          engine_kind: string;
          engine_version: string;
          id: string;
          input_snapshot: Json;
          latency_ms: number | null;
          market_cell: string | null;
          model_version_id: string | null;
          request_fingerprint: string | null;
          result_snapshot: Json;
          segment: string;
          user_id: string | null;
          value_p10_eur: number | null;
          value_p50_eur: number | null;
          value_p90_eur: number | null;
        };
        Insert: {
          actionable?: boolean;
          auction_sale_id?: string | null;
          comparable_count?: number;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind: string;
          engine_version: string;
          id?: string;
          input_snapshot?: Json;
          latency_ms?: number | null;
          market_cell?: string | null;
          model_version_id?: string | null;
          request_fingerprint?: string | null;
          result_snapshot?: Json;
          segment: string;
          user_id?: string | null;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Update: {
          actionable?: boolean;
          auction_sale_id?: string | null;
          comparable_count?: number;
          confidence_score?: number | null;
          created_at?: string;
          engine_kind?: string;
          engine_version?: string;
          id?: string;
          input_snapshot?: Json;
          latency_ms?: number | null;
          market_cell?: string | null;
          model_version_id?: string | null;
          request_fingerprint?: string | null;
          result_snapshot?: Json;
          segment?: string;
          user_id?: string | null;
          value_p10_eur?: number | null;
          value_p50_eur?: number | null;
          value_p90_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "valuation_estimates_auction_sale_id_fkey";
            columns: ["auction_sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "valuation_estimates_model_version_id_fkey";
            columns: ["model_version_id"];
            isOneToOne: false;
            referencedRelation: "valuation_model_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      valuation_model_versions: {
        Row: {
          activated_at: string | null;
          artifact: Json;
          calibration: Json;
          created_at: string;
          feature_names: string[];
          framework: string;
          id: string;
          model_key: string;
          retired_at: string | null;
          segment: string;
          status: string;
          trained_at: string | null;
          training_metrics: Json;
          training_period_end: string | null;
          training_period_start: string | null;
          training_rows: number | null;
          updated_at: string;
          version: string;
        };
        Insert: {
          activated_at?: string | null;
          artifact?: Json;
          calibration?: Json;
          created_at?: string;
          feature_names?: string[];
          framework: string;
          id?: string;
          model_key?: string;
          retired_at?: string | null;
          segment: string;
          status?: string;
          trained_at?: string | null;
          training_metrics?: Json;
          training_period_end?: string | null;
          training_period_start?: string | null;
          training_rows?: number | null;
          updated_at?: string;
          version: string;
        };
        Update: {
          activated_at?: string | null;
          artifact?: Json;
          calibration?: Json;
          created_at?: string;
          feature_names?: string[];
          framework?: string;
          id?: string;
          model_key?: string;
          retired_at?: string | null;
          segment?: string;
          status?: string;
          trained_at?: string | null;
          training_metrics?: Json;
          training_period_end?: string | null;
          training_period_start?: string | null;
          training_rows?: number | null;
          updated_at?: string;
          version?: string;
        };
        Relationships: [];
      };
      tribunals: {
        Row: {
          canonical_name: string | null;
          city: string | null;
          code: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          canonical_name?: string | null;
          city?: string | null;
          code: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          canonical_name?: string | null;
          city?: string | null;
          code?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      user_alerts: {
        Row: {
          advanced_criteria: Json;
          alert_frequency: "instant" | "daily" | "weekly";
          city: string | null;
          created_at: string;
          department: string | null;
          dpe_classes: string[];
          id: string;
          is_active: boolean;
          last_evaluated_at: string | null;
          last_match_count: number;
          max_price_per_m2: number | null;
          max_price_eur: number | null;
          min_market_discount_pct: number | null;
          min_investment_score: number | null;
          min_surface_m2: number | null;
          min_yield_pct: number | null;
          name: string;
          occupancy_status: string | null;
          property_type: string | null;
          require_house_with_land: boolean;
          updated_at: string;
          user_id: string;
          watched_zone_id: string | null;
        };
        Insert: {
          advanced_criteria?: Json;
          alert_frequency?: "instant" | "daily" | "weekly";
          city?: string | null;
          created_at?: string;
          department?: string | null;
          dpe_classes?: string[];
          id?: string;
          is_active?: boolean;
          last_evaluated_at?: string | null;
          last_match_count?: number;
          max_price_per_m2?: number | null;
          max_price_eur?: number | null;
          min_market_discount_pct?: number | null;
          min_investment_score?: number | null;
          min_surface_m2?: number | null;
          min_yield_pct?: number | null;
          name: string;
          occupancy_status?: string | null;
          property_type?: string | null;
          require_house_with_land?: boolean;
          updated_at?: string;
          user_id: string;
          watched_zone_id?: string | null;
        };
        Update: {
          advanced_criteria?: Json;
          alert_frequency?: "instant" | "daily" | "weekly";
          city?: string | null;
          created_at?: string;
          department?: string | null;
          dpe_classes?: string[];
          id?: string;
          is_active?: boolean;
          last_evaluated_at?: string | null;
          last_match_count?: number;
          max_price_per_m2?: number | null;
          max_price_eur?: number | null;
          min_market_discount_pct?: number | null;
          min_investment_score?: number | null;
          min_surface_m2?: number | null;
          min_yield_pct?: number | null;
          name?: string;
          occupancy_status?: string | null;
          property_type?: string | null;
          require_house_with_land?: boolean;
          updated_at?: string;
          user_id?: string;
          watched_zone_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_alerts_watched_zone_owner_fkey";
            columns: ["user_id", "watched_zone_id"];
            isOneToOne: false;
            referencedRelation: "user_watched_zones";
            referencedColumns: ["user_id", "id"];
          },
        ];
      };
      user_watched_zones: {
        Row: {
          alert_defaults: Json;
          center_lat: number | null;
          center_lng: number | null;
          city: string | null;
          created_at: string;
          department: string | null;
          id: string;
          is_active: boolean;
          name: string;
          postal_code_prefix: string | null;
          radius_km: number | null;
          updated_at: string;
          user_id: string;
          zone_kind: "department" | "city" | "postal_code" | "radius" | "custom";
        };
        Insert: {
          alert_defaults?: Json;
          center_lat?: number | null;
          center_lng?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          name: string;
          postal_code_prefix?: string | null;
          radius_km?: number | null;
          updated_at?: string;
          user_id: string;
          zone_kind?: "department" | "city" | "postal_code" | "radius" | "custom";
        };
        Update: {
          alert_defaults?: Json;
          center_lat?: number | null;
          center_lng?: number | null;
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          is_active?: boolean;
          name?: string;
          postal_code_prefix?: string | null;
          radius_km?: number | null;
          updated_at?: string;
          user_id?: string;
          zone_kind?: "department" | "city" | "postal_code" | "radius" | "custom";
        };
        Relationships: [];
      };
      user_alert_matches: {
        Row: {
          alert_id: string;
          dismissed_at: string | null;
          id: string;
          match_reasons: string[];
          match_snapshot: Json;
          matched_at: string;
          read_at: string | null;
          sale_id: string;
          user_id: string;
        };
        Insert: {
          alert_id: string;
          dismissed_at?: string | null;
          id?: string;
          match_reasons?: string[];
          match_snapshot?: Json;
          matched_at?: string;
          read_at?: string | null;
          sale_id: string;
          user_id: string;
        };
        Update: {
          alert_id?: string;
          dismissed_at?: string | null;
          id?: string;
          match_reasons?: string[];
          match_snapshot?: Json;
          matched_at?: string;
          read_at?: string | null;
          sale_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_alert_matches_alert_id_fkey";
            columns: ["alert_id"];
            isOneToOne: false;
            referencedRelation: "user_alerts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_matches_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      user_alert_notifications: {
        Row: {
          alert_id: string;
          created_at: string;
          delivery_channel: "in_app" | "email";
          delivery_status: "queued" | "sent" | "failed" | "cancelled";
          dismissed_at: string | null;
          id: string;
          match_id: string;
          notification_kind: "instant_match" | "daily_digest" | "weekly_digest";
          notification_snapshot: Json;
          read_at: string | null;
          sale_id: string;
          scheduled_for: string;
          sent_at: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alert_id: string;
          created_at?: string;
          delivery_channel?: "in_app" | "email";
          delivery_status?: "queued" | "sent" | "failed" | "cancelled";
          dismissed_at?: string | null;
          id?: string;
          match_id: string;
          notification_kind?: "instant_match" | "daily_digest" | "weekly_digest";
          notification_snapshot?: Json;
          read_at?: string | null;
          sale_id: string;
          scheduled_for?: string;
          sent_at?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alert_id?: string;
          created_at?: string;
          delivery_channel?: "in_app" | "email";
          delivery_status?: "queued" | "sent" | "failed" | "cancelled";
          dismissed_at?: string | null;
          id?: string;
          match_id?: string;
          notification_kind?: "instant_match" | "daily_digest" | "weekly_digest";
          notification_snapshot?: Json;
          read_at?: string | null;
          sale_id?: string;
          scheduled_for?: string;
          sent_at?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_alert_notifications_alert_id_fkey";
            columns: ["alert_id"];
            isOneToOne: false;
            referencedRelation: "user_alerts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_match_id_fkey";
            columns: ["match_id"];
            isOneToOne: false;
            referencedRelation: "user_alert_matches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_alert_notifications_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      user_notification_preferences: {
        Row: {
          alert_email_consented_at: string | null;
          alert_email_enabled: boolean;
          alert_email_revoked_at: string | null;
          consent_source: "settings" | "alert_creation" | "import" | "admin";
          created_at: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          alert_email_consented_at?: string | null;
          alert_email_enabled?: boolean;
          alert_email_revoked_at?: string | null;
          consent_source?: "settings" | "alert_creation" | "import" | "admin";
          created_at?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          alert_email_consented_at?: string | null;
          alert_email_enabled?: boolean;
          alert_email_revoked_at?: string | null;
          consent_source?: "settings" | "alert_creation" | "import" | "admin";
          created_at?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_favorites: {
        Row: {
          created_at: string;
          id: string;
          sale_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          sale_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          sale_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_favorites_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      user_profiles: {
        Row: {
          account_type: "b2c" | "b2b";
          account_tier: "free" | "premium";
          created_at: string;
          email: string | null;
          full_name: string | null;
          organization_name: string | null;
          professional_role: "lawyer" | "notary" | "bailiff" | "court" | "other" | null;
          professional_status: "not_applicable" | "pending" | "approved" | "rejected";
          updated_at: string;
          user_id: string;
          user_role: "user" | "admin";
        };
        Insert: {
          account_type?: "b2c" | "b2b";
          account_tier?: "free" | "premium";
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          organization_name?: string | null;
          professional_role?: "lawyer" | "notary" | "bailiff" | "court" | "other" | null;
          professional_status?: "not_applicable" | "pending" | "approved" | "rejected";
          updated_at?: string;
          user_id: string;
          user_role?: "user" | "admin";
        };
        Update: {
          account_type?: "b2c" | "b2b";
          account_tier?: "free" | "premium";
          created_at?: string;
          email?: string | null;
          full_name?: string | null;
          organization_name?: string | null;
          professional_role?: "lawyer" | "notary" | "bailiff" | "court" | "other" | null;
          professional_status?: "not_applicable" | "pending" | "approved" | "rejected";
          updated_at?: string;
          user_id?: string;
          user_role?: "user" | "admin";
        };
        Relationships: [];
      };
      user_api_keys: {
        Row: {
          created_at: string;
          expires_at: string | null;
          id: string;
          key_hash: string;
          key_prefix: string;
          last_used_at: string | null;
          name: string;
          revoked_at: string | null;
          scopes: string[];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          key_hash: string;
          key_prefix: string;
          last_used_at?: string | null;
          name: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          expires_at?: string | null;
          id?: string;
          key_hash?: string;
          key_prefix?: string;
          last_used_at?: string | null;
          name?: string;
          revoked_at?: string | null;
          scopes?: string[];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_subscriptions: {
        Row: {
          created_at: string;
          current_period_end: string | null;
          metadata: Json;
          plan_code: "decouverte" | "analyse";
          status: "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          current_period_end?: string | null;
          metadata?: Json;
          plan_code?: "decouverte" | "analyse";
          status?: "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          current_period_end?: string | null;
          metadata?: Json;
          plan_code?: "decouverte" | "analyse";
          status?: "trialing" | "active" | "past_due" | "paused" | "cancelled" | "expired";
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      saved_property_reports: {
        Row: {
          ceiling_snapshot: Json;
          created_at: string;
          environmental_snapshot: Json | null;
          export_count: number;
          id: string;
          last_exported_at: string | null;
          market_snapshot: Json;
          report_kind: "opportunity" | "market" | "bid_ceiling";
          report_snapshot: Json;
          sale_id: string;
          share_enabled: boolean;
          share_expires_at: string | null;
          share_token: string | null;
          share_view_count: number;
          shared_at: string | null;
          title: string;
          updated_at: string;
          user_id: string;
          user_notes: string | null;
        };
        Insert: {
          ceiling_snapshot?: Json;
          created_at?: string;
          environmental_snapshot?: Json | null;
          export_count?: number;
          id?: string;
          last_exported_at?: string | null;
          market_snapshot?: Json;
          report_kind?: "opportunity" | "market" | "bid_ceiling";
          report_snapshot?: Json;
          sale_id: string;
          share_enabled?: boolean;
          share_expires_at?: string | null;
          share_token?: string | null;
          share_view_count?: number;
          shared_at?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
          user_notes?: string | null;
        };
        Update: {
          ceiling_snapshot?: Json;
          created_at?: string;
          environmental_snapshot?: Json | null;
          export_count?: number;
          id?: string;
          last_exported_at?: string | null;
          market_snapshot?: Json;
          report_kind?: "opportunity" | "market" | "bid_ceiling";
          report_snapshot?: Json;
          sale_id?: string;
          share_enabled?: boolean;
          share_expires_at?: string | null;
          share_token?: string | null;
          share_view_count?: number;
          shared_at?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
          user_notes?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "saved_property_reports_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      feature_usage_events: {
        Row: {
          created_at: string;
          event_key:
            | "property_report.created"
            | "property_report.pdf_exported"
            | "sales.csv_exported"
            | "sales.api_feed_requested"
            | "sale_history.viewed"
            | "market.analytics_viewed"
            | "dpe.explorer_viewed"
            | "sales.favorite_added"
            | "sales.favorite_removed"
            | "sales.statistics_viewed"
            | "tribunal.statistics_viewed"
            | "bid_ceiling.calculated"
            | "dvf.comparables_viewed"
            | "valuation.backtest_viewed"
            | "valuation.estimated"
            | "outcome_graph.viewed"
            | "workspace.audience_tracking_viewed"
            | "sale_changes.monitored"
            | "lawyer.referral_requested"
            | "data_refresh.requested";
          id: string;
          metadata: Json;
          quantity: number;
          subject_id: string | null;
          subject_type: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          event_key:
            | "property_report.created"
            | "property_report.pdf_exported"
            | "sales.csv_exported"
            | "sales.api_feed_requested"
            | "sale_history.viewed"
            | "market.analytics_viewed"
            | "dpe.explorer_viewed"
            | "sales.favorite_added"
            | "sales.favorite_removed"
            | "sales.statistics_viewed"
            | "tribunal.statistics_viewed"
            | "bid_ceiling.calculated"
            | "dvf.comparables_viewed"
            | "valuation.backtest_viewed"
            | "valuation.estimated"
            | "outcome_graph.viewed"
            | "workspace.audience_tracking_viewed"
            | "sale_changes.monitored"
            | "lawyer.referral_requested"
            | "data_refresh.requested";
          id?: string;
          metadata?: Json;
          quantity?: number;
          subject_id?: string | null;
          subject_type?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          event_key?:
            | "property_report.created"
            | "property_report.pdf_exported"
            | "sales.csv_exported"
            | "sales.api_feed_requested"
            | "sale_history.viewed"
            | "market.analytics_viewed"
            | "dpe.explorer_viewed"
            | "sales.favorite_added"
            | "sales.favorite_removed"
            | "sales.statistics_viewed"
            | "tribunal.statistics_viewed"
            | "bid_ceiling.calculated"
            | "dvf.comparables_viewed"
            | "valuation.backtest_viewed"
            | "valuation.estimated"
            | "outcome_graph.viewed"
            | "workspace.audience_tracking_viewed"
            | "sale_changes.monitored"
            | "lawyer.referral_requested"
            | "data_refresh.requested";
          id?: string;
          metadata?: Json;
          quantity?: number;
          subject_id?: string | null;
          subject_type?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      property_report_exports: {
        Row: {
          created_at: string;
          export_format: "pdf";
          id: string;
          report_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          export_format?: "pdf";
          id?: string;
          report_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          export_format?: "pdf";
          id?: string;
          report_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "property_report_exports_report_id_fkey";
            columns: ["report_id"];
            isOneToOne: false;
            referencedRelation: "saved_property_reports";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_workspaces: {
        Row: {
          alert_preferences: Json;
          checklist: Json;
          created_at: string;
          document_reviews: Json;
          id: string;
          last_synced_at: string;
          next_action: string | null;
          next_action_due_at: string | null;
          private_notes: Json;
          sale_id: string;
          target_yield_pct: number | null;
          tracking_status: "watching" | "reviewing" | "bidding" | "won" | "lost" | "archived";
          updated_at: string;
          user_id: string;
          user_max_bid_eur: number | null;
        };
        Insert: {
          alert_preferences?: Json;
          checklist?: Json;
          created_at?: string;
          document_reviews?: Json;
          id?: string;
          last_synced_at?: string;
          next_action?: string | null;
          next_action_due_at?: string | null;
          private_notes?: Json;
          sale_id: string;
          target_yield_pct?: number | null;
          tracking_status?: "watching" | "reviewing" | "bidding" | "won" | "lost" | "archived";
          updated_at?: string;
          user_id: string;
          user_max_bid_eur?: number | null;
        };
        Update: {
          alert_preferences?: Json;
          checklist?: Json;
          created_at?: string;
          document_reviews?: Json;
          id?: string;
          last_synced_at?: string;
          next_action?: string | null;
          next_action_due_at?: string | null;
          private_notes?: Json;
          sale_id?: string;
          target_yield_pct?: number | null;
          tracking_status?: "watching" | "reviewing" | "bidding" | "won" | "lost" | "archived";
          updated_at?: string;
          user_id?: string;
          user_max_bid_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspaces_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      user_sale_watch_snapshots: {
        Row: {
          created_at: string;
          fingerprint: string;
          id: string;
          last_checked_at: string;
          sale_id: string;
          snapshot: Json;
          updated_at: string;
          user_id: string;
          watch_id: string;
          watch_kind: "alert_match" | "favorite" | "workspace";
        };
        Insert: {
          created_at?: string;
          fingerprint: string;
          id?: string;
          last_checked_at?: string;
          sale_id: string;
          snapshot?: Json;
          updated_at?: string;
          user_id: string;
          watch_id: string;
          watch_kind: "alert_match" | "favorite" | "workspace";
        };
        Update: {
          created_at?: string;
          fingerprint?: string;
          id?: string;
          last_checked_at?: string;
          sale_id?: string;
          snapshot?: Json;
          updated_at?: string;
          user_id?: string;
          watch_id?: string;
          watch_kind?: "alert_match" | "favorite" | "workspace";
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_watch_snapshots_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      user_sale_change_events: {
        Row: {
          change_summary: Json;
          created_at: string;
          detected_at: string;
          dismissed_at: string | null;
          event_kind:
            | "price_changed"
            | "audience_changed"
            | "status_changed"
            | "documents_changed"
            | "score_changed";
          fingerprint: string;
          id: string;
          new_snapshot: Json;
          old_snapshot: Json;
          read_at: string | null;
          sale_id: string;
          severity: "info" | "important" | "urgent";
          summary_label: string;
          user_id: string;
          watch_id: string;
          watch_kind: "alert_match" | "favorite" | "workspace";
        };
        Insert: {
          change_summary?: Json;
          created_at?: string;
          detected_at?: string;
          dismissed_at?: string | null;
          event_kind:
            | "price_changed"
            | "audience_changed"
            | "status_changed"
            | "documents_changed"
            | "score_changed";
          fingerprint: string;
          id?: string;
          new_snapshot?: Json;
          old_snapshot?: Json;
          read_at?: string | null;
          sale_id: string;
          severity?: "info" | "important" | "urgent";
          summary_label: string;
          user_id: string;
          watch_id: string;
          watch_kind: "alert_match" | "favorite" | "workspace";
        };
        Update: {
          change_summary?: Json;
          created_at?: string;
          detected_at?: string;
          dismissed_at?: string | null;
          event_kind?:
            | "price_changed"
            | "audience_changed"
            | "status_changed"
            | "documents_changed"
            | "score_changed";
          fingerprint?: string;
          id?: string;
          new_snapshot?: Json;
          old_snapshot?: Json;
          read_at?: string | null;
          sale_id?: string;
          severity?: "info" | "important" | "urgent";
          summary_label?: string;
          user_id?: string;
          watch_id?: string;
          watch_kind?: "alert_match" | "favorite" | "workspace";
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_change_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_workspace_collaborators: {
        Row: {
          accepted_at: string | null;
          collaborator_user_id: string | null;
          created_at: string;
          id: string;
          invited_at: string;
          invited_by: string;
          invited_email: string;
          owner_id: string;
          revoked_at: string | null;
          role: "viewer" | "commenter" | "editor";
          status: "invited" | "accepted" | "revoked";
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          collaborator_user_id?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string;
          invited_by: string;
          invited_email: string;
          owner_id: string;
          revoked_at?: string | null;
          role?: "viewer" | "commenter" | "editor";
          status?: "invited" | "accepted" | "revoked";
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          accepted_at?: string | null;
          collaborator_user_id?: string | null;
          created_at?: string;
          id?: string;
          invited_at?: string;
          invited_by?: string;
          invited_email?: string;
          owner_id?: string;
          revoked_at?: string | null;
          role?: "viewer" | "commenter" | "editor";
          status?: "invited" | "accepted" | "revoked";
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspace_collaborators_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sale_workspaces";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_workspace_annotations: {
        Row: {
          author_id: string;
          body: string;
          created_at: string;
          document_key: string | null;
          document_label: string | null;
          document_type: string | null;
          document_url: string | null;
          excerpt: string | null;
          id: string;
          page_number: number | null;
          resolved_at: string | null;
          sale_id: string;
          status: "open" | "resolved" | "archived";
          target_kind: "general" | "document" | "page" | "excerpt";
          updated_at: string;
          workspace_id: string;
        };
        Insert: {
          author_id: string;
          body: string;
          created_at?: string;
          document_key?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          page_number?: number | null;
          resolved_at?: string | null;
          sale_id: string;
          status?: "open" | "resolved" | "archived";
          target_kind?: "general" | "document" | "page" | "excerpt";
          updated_at?: string;
          workspace_id: string;
        };
        Update: {
          author_id?: string;
          body?: string;
          created_at?: string;
          document_key?: string | null;
          document_label?: string | null;
          document_type?: string | null;
          document_url?: string | null;
          excerpt?: string | null;
          id?: string;
          page_number?: number | null;
          resolved_at?: string | null;
          sale_id?: string;
          status?: "open" | "resolved" | "archived";
          target_kind?: "general" | "document" | "page" | "excerpt";
          updated_at?: string;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sale_workspace_annotations_workspace_id_fkey";
            columns: ["workspace_id"];
            isOneToOne: false;
            referencedRelation: "sale_workspaces";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "sale_workspace_annotations_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      sale_data_exports: {
        Row: {
          created_at: string;
          export_kind: "sales_csv" | "sales_api";
          id: string;
          row_count: number;
          search_snapshot: Json;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          export_kind?: "sales_csv" | "sales_api";
          id?: string;
          row_count?: number;
          search_snapshot?: Json;
          user_id: string;
        };
        Update: {
          created_at?: string;
          export_kind?: "sales_csv" | "sales_api";
          id?: string;
          row_count?: number;
          search_snapshot?: Json;
          user_id?: string;
        };
        Relationships: [];
      };
      user_sale_analysis_sets: {
        Row: {
          analysis_kind: "comparison" | "watchlist" | "portfolio";
          assumptions: Json;
          created_at: string;
          id: string;
          is_archived: boolean;
          name: string;
          notes: string | null;
          share_expires_at: string | null;
          share_token_hash: string | null;
          shared_snapshot: Json | null;
          shared_at: string | null;
          summary_snapshot: Json;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          analysis_kind?: "comparison" | "watchlist" | "portfolio";
          assumptions?: Json;
          created_at?: string;
          id?: string;
          is_archived?: boolean;
          name: string;
          notes?: string | null;
          share_expires_at?: string | null;
          share_token_hash?: string | null;
          shared_snapshot?: Json | null;
          shared_at?: string | null;
          summary_snapshot?: Json;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          analysis_kind?: "comparison" | "watchlist" | "portfolio";
          assumptions?: Json;
          created_at?: string;
          id?: string;
          is_archived?: boolean;
          name?: string;
          notes?: string | null;
          share_expires_at?: string | null;
          share_token_hash?: string | null;
          shared_snapshot?: Json | null;
          shared_at?: string | null;
          summary_snapshot?: Json;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_sale_analysis_items: {
        Row: {
          analysis_set_id: string;
          created_at: string;
          decision_status: "watching" | "shortlisted" | "bid_ready" | "rejected" | "won" | "lost";
          expected_margin_pct: number | null;
          id: string;
          item_order: number;
          notes: string | null;
          sale_id: string;
          target_yield_pct: number | null;
          updated_at: string;
          user_id: string;
          user_max_bid_eur: number | null;
        };
        Insert: {
          analysis_set_id: string;
          created_at?: string;
          decision_status?: "watching" | "shortlisted" | "bid_ready" | "rejected" | "won" | "lost";
          expected_margin_pct?: number | null;
          id?: string;
          item_order?: number;
          notes?: string | null;
          sale_id: string;
          target_yield_pct?: number | null;
          updated_at?: string;
          user_id: string;
          user_max_bid_eur?: number | null;
        };
        Update: {
          analysis_set_id?: string;
          created_at?: string;
          decision_status?: "watching" | "shortlisted" | "bid_ready" | "rejected" | "won" | "lost";
          expected_margin_pct?: number | null;
          id?: string;
          item_order?: number;
          notes?: string | null;
          sale_id?: string;
          target_yield_pct?: number | null;
          updated_at?: string;
          user_id?: string;
          user_max_bid_eur?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_sale_analysis_items_analysis_set_id_user_id_fkey";
            columns: ["user_id", "analysis_set_id"];
            isOneToOne: false;
            referencedRelation: "user_sale_analysis_sets";
            referencedColumns: ["user_id", "id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_sale_analysis_items_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      cnb_lawyer_directory: {
        Row: {
          address_line_1: string | null;
          address_line_2: string | null;
          bar_association: string;
          bar_key: string;
          city: string | null;
          display_name: string;
          firm_name: string | null;
          firm_siret_siren: string | null;
          first_name: string | null;
          imported_at: string;
          languages: string[];
          last_name: string;
          oath_date: string | null;
          postal_code: string | null;
          source_key: string;
          source_resource_id: string;
          source_updated_at: string;
          specializations: string[];
        };
        Insert: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          bar_association: string;
          bar_key: string;
          city?: string | null;
          display_name: string;
          firm_name?: string | null;
          firm_siret_siren?: string | null;
          first_name?: string | null;
          imported_at?: string;
          languages?: string[];
          last_name: string;
          oath_date?: string | null;
          postal_code?: string | null;
          source_key: string;
          source_resource_id: string;
          source_updated_at: string;
          specializations: string[];
        };
        Update: {
          address_line_1?: string | null;
          address_line_2?: string | null;
          bar_association?: string;
          bar_key?: string;
          city?: string | null;
          display_name?: string;
          firm_name?: string | null;
          firm_siret_siren?: string | null;
          first_name?: string | null;
          imported_at?: string;
          languages?: string[];
          last_name?: string;
          oath_date?: string | null;
          postal_code?: string | null;
          source_key?: string;
          source_resource_id?: string;
          source_updated_at?: string;
          specializations?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "cnb_lawyer_directory_source_resource_id_fkey";
            columns: ["source_resource_id"];
            isOneToOne: false;
            referencedRelation: "cnb_lawyer_directory_imports";
            referencedColumns: ["resource_id"];
          },
        ];
      };
      cnb_lawyer_directory_imports: {
        Row: {
          completed_at: string | null;
          error_message: string | null;
          record_count: number;
          resource_id: string;
          resource_title: string;
          resource_url: string;
          source_published_at: string;
          started_at: string;
          status: string;
        };
        Insert: {
          completed_at?: string | null;
          error_message?: string | null;
          record_count?: number;
          resource_id: string;
          resource_title: string;
          resource_url: string;
          source_published_at: string;
          started_at?: string;
          status: string;
        };
        Update: {
          completed_at?: string | null;
          error_message?: string | null;
          record_count?: number;
          resource_id?: string;
          resource_title?: string;
          resource_url?: string;
          source_published_at?: string;
          started_at?: string;
          status?: string;
        };
        Relationships: [];
      };
      referenced_lawyers: {
        Row: {
          accepts_judicial_auctions: boolean;
          accepts_remote_contact: boolean;
          address: string | null;
          bar_association: string | null;
          bar_number: string | null;
          city: string | null;
          created_at: string;
          created_by: string | null;
          department: string | null;
          display_name: string;
          email: string | null;
          firm_name: string | null;
          id: string;
          paid_placement_ends_at: string | null;
          paid_placement_starts_at: string | null;
          paid_placement_status:
            | "not_started"
            | "trial"
            | "active"
            | "past_due"
            | "paused"
            | "cancelled";
          phone: string | null;
          practice_tags: string[];
          priority_weight: number;
          profile_summary: string | null;
          status: "draft" | "active" | "paused" | "archived";
          updated_at: string;
          website_url: string | null;
        };
        Insert: {
          accepts_judicial_auctions?: boolean;
          accepts_remote_contact?: boolean;
          address?: string | null;
          bar_association?: string | null;
          bar_number?: string | null;
          city?: string | null;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          display_name: string;
          email?: string | null;
          firm_name?: string | null;
          id?: string;
          paid_placement_ends_at?: string | null;
          paid_placement_starts_at?: string | null;
          paid_placement_status?:
            | "not_started"
            | "trial"
            | "active"
            | "past_due"
            | "paused"
            | "cancelled";
          phone?: string | null;
          practice_tags?: string[];
          priority_weight?: number;
          profile_summary?: string | null;
          status?: "draft" | "active" | "paused" | "archived";
          updated_at?: string;
          website_url?: string | null;
        };
        Update: {
          accepts_judicial_auctions?: boolean;
          accepts_remote_contact?: boolean;
          address?: string | null;
          bar_association?: string | null;
          bar_number?: string | null;
          city?: string | null;
          created_at?: string;
          created_by?: string | null;
          department?: string | null;
          display_name?: string;
          email?: string | null;
          firm_name?: string | null;
          id?: string;
          paid_placement_ends_at?: string | null;
          paid_placement_starts_at?: string | null;
          paid_placement_status?:
            | "not_started"
            | "trial"
            | "active"
            | "past_due"
            | "paused"
            | "cancelled";
          phone?: string | null;
          practice_tags?: string[];
          priority_weight?: number;
          profile_summary?: string | null;
          status?: "draft" | "active" | "paused" | "archived";
          updated_at?: string;
          website_url?: string | null;
        };
        Relationships: [];
      };
      referenced_lawyer_coverage: {
        Row: {
          city: string | null;
          created_at: string;
          department: string | null;
          id: string;
          lawyer_id: string;
          postal_code_prefix: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
        };
        Insert: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          lawyer_id: string;
          postal_code_prefix?: string | null;
          tribunal_code?: string | null;
          tribunal_name?: string | null;
        };
        Update: {
          city?: string | null;
          created_at?: string;
          department?: string | null;
          id?: string;
          lawyer_id?: string;
          postal_code_prefix?: string | null;
          tribunal_code?: string | null;
          tribunal_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "referenced_lawyer_coverage_lawyer_id_fkey";
            columns: ["lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_cases: {
        Row: {
          body_text: string;
          completed_at: string | null;
          created_at: string;
          created_by: string;
          failure_reason: string | null;
          id: string;
          inbound_token: string;
          initiator_mission_id: string | null;
          metadata: Json;
          missing_information: string[];
          normalized_recipient_email: string;
          provider_message_id: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name: string | null;
          replied_at: string | null;
          sale_id: string;
          sent_at: string | null;
          status: "draft" | "sending" | "sent" | "replied" | "review" | "completed" | "failed";
          subject: string;
          updated_at: string;
        };
        Insert: {
          body_text: string;
          completed_at?: string | null;
          created_at?: string;
          created_by: string;
          failure_reason?: string | null;
          id?: string;
          inbound_token?: string;
          initiator_mission_id?: string | null;
          metadata?: Json;
          missing_information?: string[];
          normalized_recipient_email: string;
          provider_message_id?: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind?: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name?: string | null;
          replied_at?: string | null;
          sale_id: string;
          sent_at?: string | null;
          status?: "draft" | "sending" | "sent" | "replied" | "review" | "completed" | "failed";
          subject: string;
          updated_at?: string;
        };
        Update: {
          body_text?: string;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string;
          failure_reason?: string | null;
          id?: string;
          inbound_token?: string;
          initiator_mission_id?: string | null;
          metadata?: Json;
          missing_information?: string[];
          normalized_recipient_email?: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email?: string;
          recipient_kind?: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name?: string | null;
          replied_at?: string | null;
          sale_id?: string;
          sent_at?: string | null;
          status?: "draft" | "sending" | "sent" | "replied" | "review" | "completed" | "failed";
          subject?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      information_agent_case_subscribers: {
        Row: {
          case_id: string;
          is_initiator: boolean;
          last_notified_at: string | null;
          mission_id: string;
          notify_on_reply: boolean;
          requested_question_keys: string[];
          subscribed_at: string;
          user_id: string;
        };
        Insert: {
          case_id: string;
          is_initiator?: boolean;
          last_notified_at?: string | null;
          mission_id: string;
          notify_on_reply?: boolean;
          requested_question_keys?: string[];
          subscribed_at?: string;
          user_id: string;
        };
        Update: {
          case_id?: string;
          is_initiator?: boolean;
          last_notified_at?: string | null;
          mission_id?: string;
          notify_on_reply?: boolean;
          requested_question_keys?: string[];
          subscribed_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      information_agent_evidence_assets: {
        Row: {
          case_id: string;
          created_at: string;
          id: string;
          message_id: string;
          metadata: Json;
          mime_type: string;
          original_filename: string;
          provider_attachment_id: string | null;
          review_status: "pending" | "accepted" | "rejected";
          rights_status: "unverified" | "authorized" | "restricted";
          sale_id: string;
          sha256: string;
          size_bytes: number;
          storage_bucket: string;
          storage_path: string;
        };
        Insert: {
          case_id: string;
          created_at?: string;
          id?: string;
          message_id: string;
          metadata?: Json;
          mime_type: string;
          original_filename: string;
          provider_attachment_id?: string | null;
          review_status?: "pending" | "accepted" | "rejected";
          rights_status?: "unverified" | "authorized" | "restricted";
          sale_id: string;
          sha256: string;
          size_bytes: number;
          storage_bucket?: string;
          storage_path: string;
        };
        Update: {
          case_id?: string;
          created_at?: string;
          id?: string;
          message_id?: string;
          metadata?: Json;
          mime_type?: string;
          original_filename?: string;
          provider_attachment_id?: string | null;
          review_status?: "pending" | "accepted" | "rejected";
          rights_status?: "unverified" | "authorized" | "restricted";
          sale_id?: string;
          sha256?: string;
          size_bytes?: number;
          storage_bucket?: string;
          storage_path?: string;
        };
        Relationships: [];
      };
      information_agent_email_templates: {
        Row: {
          blocks: Json;
          created_at: string;
          created_by: string | null;
          id: string;
          name: string;
          published_at: string | null;
          published_by: string | null;
          revision: number;
          status: "draft" | "published" | "archived";
          subject_template: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          blocks: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          status?: "draft" | "published" | "archived";
          subject_template: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          blocks?: Json;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          name?: string;
          published_at?: string | null;
          published_by?: string | null;
          revision?: number;
          status?: "draft" | "published" | "archived";
          subject_template?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      information_agent_evidence_extractions: {
        Row: {
          asset_id: string;
          attempts: number;
          available_at: string;
          case_id: string;
          completed_at: string | null;
          created_at: string;
          detected_mime_type: string | null;
          document_kind: string | null;
          error_code: string | null;
          error_message: string | null;
          extracted_facts: Json;
          extracted_text: string | null;
          id: string;
          is_encrypted: boolean;
          locked_at: string | null;
          message_id: string;
          metadata: Json;
          page_count: number | null;
          pages: Json;
          processor: string;
          processor_version: string;
          sale_id: string;
          started_at: string | null;
          status:
            | "queued"
            | "processing"
            | "completed"
            | "needs_password"
            | "unsupported"
            | "failed";
          summary: string | null;
          updated_at: string;
        };
        Insert: {
          asset_id: string;
          attempts?: number;
          available_at?: string;
          case_id: string;
          completed_at?: string | null;
          created_at?: string;
          detected_mime_type?: string | null;
          document_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          extracted_facts?: Json;
          extracted_text?: string | null;
          id?: string;
          is_encrypted?: boolean;
          locked_at?: string | null;
          message_id: string;
          metadata?: Json;
          page_count?: number | null;
          pages?: Json;
          processor?: string;
          processor_version?: string;
          sale_id: string;
          started_at?: string | null;
          status?:
            | "queued"
            | "processing"
            | "completed"
            | "needs_password"
            | "unsupported"
            | "failed";
          summary?: string | null;
          updated_at?: string;
        };
        Update: {
          asset_id?: string;
          attempts?: number;
          available_at?: string;
          case_id?: string;
          completed_at?: string | null;
          created_at?: string;
          detected_mime_type?: string | null;
          document_kind?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          extracted_facts?: Json;
          extracted_text?: string | null;
          id?: string;
          is_encrypted?: boolean;
          locked_at?: string | null;
          message_id?: string;
          metadata?: Json;
          page_count?: number | null;
          pages?: Json;
          processor?: string;
          processor_version?: string;
          sale_id?: string;
          started_at?: string | null;
          status?:
            | "queued"
            | "processing"
            | "completed"
            | "needs_password"
            | "unsupported"
            | "failed";
          summary?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      information_agent_fact_candidates: {
        Row: {
          case_id: string;
          confidence: number;
          created_at: string;
          display_value: string;
          evidence_asset_id: string | null;
          evidence_excerpt: string | null;
          extraction_method: string;
          fact_key:
            | "surface_m2"
            | "land_surface_m2"
            | "rooms_count"
            | "occupancy_status"
            | "visit_information"
            | "sale_date"
            | "starting_price_eur"
            | "energy_diagnostics"
            | "property_type"
            | "address"
            | "document"
            | "photo";
          id: string;
          message_id: string;
          metadata: Json;
          proposed_value: Json;
          review_notes: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          sale_id: string;
          source_locator: string | null;
          source_page: number | null;
          status: "pending" | "accepted" | "rejected" | "conflict";
          updated_at: string;
        };
        Insert: {
          case_id: string;
          confidence: number;
          created_at?: string;
          display_value: string;
          evidence_asset_id?: string | null;
          evidence_excerpt?: string | null;
          extraction_method?: string;
          fact_key:
            | "surface_m2"
            | "land_surface_m2"
            | "rooms_count"
            | "occupancy_status"
            | "visit_information"
            | "sale_date"
            | "starting_price_eur"
            | "energy_diagnostics"
            | "property_type"
            | "address"
            | "document"
            | "photo";
          id?: string;
          message_id: string;
          metadata?: Json;
          proposed_value: Json;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          sale_id: string;
          source_locator?: string | null;
          source_page?: number | null;
          status?: "pending" | "accepted" | "rejected" | "conflict";
          updated_at?: string;
        };
        Update: {
          case_id?: string;
          confidence?: number;
          created_at?: string;
          display_value?: string;
          evidence_asset_id?: string | null;
          evidence_excerpt?: string | null;
          extraction_method?: string;
          fact_key?:
            | "surface_m2"
            | "land_surface_m2"
            | "rooms_count"
            | "occupancy_status"
            | "visit_information"
            | "sale_date"
            | "starting_price_eur"
            | "energy_diagnostics"
            | "property_type"
            | "address"
            | "document"
            | "photo";
          id?: string;
          message_id?: string;
          metadata?: Json;
          proposed_value?: Json;
          review_notes?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          sale_id?: string;
          source_locator?: string | null;
          source_page?: number | null;
          status?: "pending" | "accepted" | "rejected" | "conflict";
          updated_at?: string;
        };
        Relationships: [];
      };
      information_agent_missions: {
        Row: {
          ai_disclosure_version: string;
          approved_at: string | null;
          approved_message_sha256: string | null;
          body_text: string;
          case_id: string | null;
          completed_at: string | null;
          created_at: string;
          failure_reason: string | null;
          followup_count: number;
          id: string;
          last_followup_at: string | null;
          metadata: Json;
          missing_information: string[];
          privacy_version: string;
          provider_message_id: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name: string | null;
          replied_at: string | null;
          reply_to_email: string | null;
          sale_id: string | null;
          sale_snapshot: Json;
          sent_at: string | null;
          share_requester_email: boolean;
          status:
            | "draft"
            | "approved"
            | "sending"
            | "sent"
            | "subscribed"
            | "replied"
            | "completed"
            | "failed"
            | "cancelled";
          subject: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          ai_disclosure_version?: string;
          approved_at?: string | null;
          approved_message_sha256?: string | null;
          body_text: string;
          case_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          failure_reason?: string | null;
          followup_count?: number;
          id?: string;
          last_followup_at?: string | null;
          metadata?: Json;
          missing_information?: string[];
          privacy_version: string;
          provider_message_id?: string | null;
          question_keys: string[];
          recipient_email: string;
          recipient_kind?: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name?: string | null;
          replied_at?: string | null;
          reply_to_email?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          share_requester_email?: boolean;
          status?:
            | "draft"
            | "approved"
            | "sending"
            | "sent"
            | "subscribed"
            | "replied"
            | "completed"
            | "failed"
            | "cancelled";
          subject: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          ai_disclosure_version?: string;
          approved_at?: string | null;
          approved_message_sha256?: string | null;
          body_text?: string;
          case_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          failure_reason?: string | null;
          followup_count?: number;
          id?: string;
          last_followup_at?: string | null;
          metadata?: Json;
          missing_information?: string[];
          privacy_version?: string;
          provider_message_id?: string | null;
          question_keys?: string[];
          recipient_email?: string;
          recipient_kind?: "source_lawyer" | "source_contact" | "manual_professional";
          recipient_name?: string | null;
          replied_at?: string | null;
          reply_to_email?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          share_requester_email?: boolean;
          status?:
            | "draft"
            | "approved"
            | "sending"
            | "sent"
            | "subscribed"
            | "replied"
            | "completed"
            | "failed"
            | "cancelled";
          subject?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_missions_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
        ];
      };
      information_agent_messages: {
        Row: {
          attachments: Json;
          body_text: string;
          case_id: string | null;
          created_at: string;
          delivery_status: "draft" | "queued" | "sent" | "received" | "failed";
          direction: "outbound" | "inbound";
          from_email: string | null;
          id: string;
          message_kind: "initial" | "followup" | "reply" | "manual_note";
          metadata: Json;
          mission_id: string;
          provider_message_id: string | null;
          received_at: string | null;
          sent_at: string | null;
          subject: string;
          to_email: string | null;
          user_id: string;
        };
        Insert: {
          attachments?: Json;
          body_text: string;
          case_id?: string | null;
          created_at?: string;
          delivery_status: "draft" | "queued" | "sent" | "received" | "failed";
          direction: "outbound" | "inbound";
          from_email?: string | null;
          id?: string;
          message_kind: "initial" | "followup" | "reply" | "manual_note";
          metadata?: Json;
          mission_id: string;
          provider_message_id?: string | null;
          received_at?: string | null;
          sent_at?: string | null;
          subject: string;
          to_email?: string | null;
          user_id: string;
        };
        Update: {
          attachments?: Json;
          body_text?: string;
          case_id?: string | null;
          created_at?: string;
          delivery_status?: "draft" | "queued" | "sent" | "received" | "failed";
          direction?: "outbound" | "inbound";
          from_email?: string | null;
          id?: string;
          message_kind?: "initial" | "followup" | "reply" | "manual_note";
          metadata?: Json;
          mission_id?: string;
          provider_message_id?: string | null;
          received_at?: string | null;
          sent_at?: string | null;
          subject?: string;
          to_email?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "information_agent_messages_mission_id_fkey";
            columns: ["mission_id"];
            isOneToOne: false;
            referencedRelation: "information_agent_missions";
            referencedColumns: ["id"];
          },
        ];
      };
      lawyer_referral_requests: {
        Row: {
          admin_notes: string | null;
          assigned_at: string | null;
          created_at: string;
          financing_ready: boolean | null;
          id: string;
          matching_status: "unmatched" | "matched" | "manual_review";
          max_bid_eur: number | null;
          message: string | null;
          metadata: Json;
          phone: string | null;
          preferred_contact_method: "email" | "phone" | "either";
          requested_lawyer_id: string | null;
          requester_email: string | null;
          requester_id: string;
          responded_at: string | null;
          sale_id: string | null;
          sale_snapshot: Json;
          sent_at: string | null;
          status: "new" | "manual_review" | "sent_to_lawyer" | "responded" | "closed" | "cancelled";
          updated_at: string;
        };
        Insert: {
          admin_notes?: string | null;
          assigned_at?: string | null;
          created_at?: string;
          financing_ready?: boolean | null;
          id?: string;
          matching_status?: "unmatched" | "matched" | "manual_review";
          max_bid_eur?: number | null;
          message?: string | null;
          metadata?: Json;
          phone?: string | null;
          preferred_contact_method?: "email" | "phone" | "either";
          requested_lawyer_id?: string | null;
          requester_email?: string | null;
          requester_id: string;
          responded_at?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          status?:
            | "new"
            | "manual_review"
            | "sent_to_lawyer"
            | "responded"
            | "closed"
            | "cancelled";
          updated_at?: string;
        };
        Update: {
          admin_notes?: string | null;
          assigned_at?: string | null;
          created_at?: string;
          financing_ready?: boolean | null;
          id?: string;
          matching_status?: "unmatched" | "matched" | "manual_review";
          max_bid_eur?: number | null;
          message?: string | null;
          metadata?: Json;
          phone?: string | null;
          preferred_contact_method?: "email" | "phone" | "either";
          requested_lawyer_id?: string | null;
          requester_email?: string | null;
          requester_id?: string;
          responded_at?: string | null;
          sale_id?: string | null;
          sale_snapshot?: Json;
          sent_at?: string | null;
          status?:
            | "new"
            | "manual_review"
            | "sent_to_lawyer"
            | "responded"
            | "closed"
            | "cancelled";
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lawyer_referral_requests_requested_lawyer_id_fkey";
            columns: ["requested_lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_referral_requests_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      lawyer_placement_events: {
        Row: {
          created_at: string;
          event_type: "impression" | "cta_click";
          id: string;
          lawyer_id: string;
          matching_basis: "tribunal_code" | "department" | "postal_code_prefix" | "city" | null;
          metadata: Json;
          placement_slot: string;
          sale_id: string | null;
          sector_label: string | null;
        };
        Insert: {
          created_at?: string;
          event_type: "impression" | "cta_click";
          id?: string;
          lawyer_id: string;
          matching_basis?: "tribunal_code" | "department" | "postal_code_prefix" | "city" | null;
          metadata?: Json;
          placement_slot?: string;
          sale_id?: string | null;
          sector_label?: string | null;
        };
        Update: {
          created_at?: string;
          event_type?: "impression" | "cta_click";
          id?: string;
          lawyer_id?: string;
          matching_basis?: "tribunal_code" | "department" | "postal_code_prefix" | "city" | null;
          metadata?: Json;
          placement_slot?: string;
          sale_id?: string | null;
          sector_label?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "lawyer_placement_events_lawyer_id_fkey";
            columns: ["lawyer_id"];
            isOneToOne: false;
            referencedRelation: "referenced_lawyers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "auction_sales";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lawyer_placement_events_sale_id_fkey";
            columns: ["sale_id"];
            isOneToOne: false;
            referencedRelation: "v_auction_sales_app";
            referencedColumns: ["id"];
          },
        ];
      };
      listing_publication_requests: {
        Row: {
          admin_notes: string | null;
          anonymize_documents: boolean;
          cautions: string | null;
          court: string | null;
          created_at: string;
          description: string | null;
          document_types: string[];
          hearing_date: string | null;
          id: string;
          location: string | null;
          promotion_options: string[];
          requester_email: string | null;
          requester_id: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          starting_price_eur: number | null;
          status: "pending" | "approved" | "rejected";
          strengths: string | null;
          submitted_documents: Json;
          title: string;
          updated_at: string;
        };
        Insert: {
          admin_notes?: string | null;
          anonymize_documents?: boolean;
          cautions?: string | null;
          court?: string | null;
          created_at?: string;
          description?: string | null;
          document_types?: string[];
          hearing_date?: string | null;
          id?: string;
          location?: string | null;
          promotion_options?: string[];
          requester_email?: string | null;
          requester_id: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          starting_price_eur?: number | null;
          status?: "pending" | "approved" | "rejected";
          strengths?: string | null;
          submitted_documents?: Json;
          title: string;
          updated_at?: string;
        };
        Update: {
          admin_notes?: string | null;
          anonymize_documents?: boolean;
          cautions?: string | null;
          court?: string | null;
          created_at?: string;
          description?: string | null;
          document_types?: string[];
          hearing_date?: string | null;
          id?: string;
          location?: string | null;
          promotion_options?: string[];
          requester_email?: string | null;
          requester_id?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          starting_price_eur?: number | null;
          status?: "pending" | "approved" | "rejected";
          strengths?: string | null;
          submitted_documents?: Json;
          title?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      v_auction_sales_app: {
        Row: {
          sale_procedure: Json | null;
          sale_venue_type: string | null;
          sale_legal_framework: string | null;
          sale_verification_status: string | null;
          address: string | null;
          adjudication_price_eur: number | null;
          about_description: string | null;
          app_surface_kind: string | null;
          app_surface_m2: number | null;
          bathrooms_count: number | null;
          bedrooms_count: number | null;
          carrez_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          dedupe_confidence: string | null;
          department: string | null;
          description: string | null;
          documents: Json | null;
          documents_rich: Json | null;
          habitable_surface_m2: number | null;
          has_air_conditioning: boolean | null;
          has_double_glazing: boolean | null;
          has_garage: boolean | null;
          has_garden: boolean | null;
          has_pool: boolean | null;
          has_terrace: boolean | null;
          id: string | null;
          score_confidence: number | null;
          score_factors: Json | null;
          investment_score: number | null;
          investment_summary: string | null;
          land_surface_m2: number | null;
          latitude: number | null;
          lawyer_contact: string | null;
          lawyer_name: string | null;
          llm_display_description: string | null;
          longitude: number | null;
          media: Json | null;
          occupancy_status: string | null;
          parking_count: number | null;
          postal_code: string | null;
          primary_source: string | null;
          property_type: string | null;
          quality_flags: Json | null;
          risk_notes: string | null;
          risks: Json | null;
          rooms_count: number | null;
          sale_date: string | null;
          score_version: string | null;
          source_name: string | null;
          source_blocks: Json | null;
          source_blocks_by_source: Json | null;
          source_description: string | null;
          source_url: string | null;
          source_urls: Json | null;
          starting_price_eur: number | null;
          status: string | null;
          surface_confidence: number | null;
          surface_evidence: string | null;
          surface_scope: string | null;
          surface_source: string | null;
          title: string | null;
          tribunal: string | null;
          tribunal_city: string | null;
          tribunal_code: string | null;
          tribunal_name: string | null;
          updated_at: string | null;
          visit_dates: Json | null;
        };
        Relationships: [];
      };
      v_auction_map_pins: {
        Row: {
          app_surface_m2: number | null;
          city: string | null;
          created_at: string | null;
          department: string | null;
          id: string | null;
          investment_score: number | null;
          latitude: number | null;
          longitude: number | null;
          occupancy_status: string | null;
          property_type: string | null;
          sale_date: string | null;
          score_confidence: number | null;
          starting_price_eur: number | null;
          status: string | null;
          title: string | null;
        };
        Relationships: [];
      };
      v_auction_sales_app_preview: {
        Row: {
          id: string | null;
          sale_venue_type: string | null;
          sale_verification_status: string | null;
          starting_price_eur: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      save_sale_analysis_set: {
        Args: { p_metadata: Json; p_items: Json; p_set_id?: string };
        Returns: Database["public"]["Tables"]["user_sale_analysis_sets"]["Row"];
      };
      approve_information_agent_mission_bounded: {
        Args: { p_message_sha256: string; p_mission_id: string; p_user_id: string };
        Returns: {
          approved_at: string;
          case_id: string;
          inbound_token: string;
          mission_id: string;
          should_send: boolean;
          usage_count: number;
        }[];
      };
      claim_information_agent_evidence_extractions: {
        Args: { p_limit?: number };
        Returns: Database["public"]["Tables"]["information_agent_evidence_extractions"]["Row"][];
      };
      publish_information_agent_email_template: {
        Args: { p_admin_id: string; p_template_id: string };
        Returns: Database["public"]["Tables"]["information_agent_email_templates"]["Row"];
      };
      review_information_agent_fact_candidate: {
        Args: {
          p_decision: string;
          p_fact_id: string;
          p_notes?: string | null;
          p_reviewer_id: string;
        };
        Returns: Json;
      };
      stage_information_agent_evidence_publication: {
        Args: { p_fact_id: string; p_public_path: string; p_public_url: string };
        Returns: Json;
      };
      subscribe_information_agent_mission: {
        Args: { p_mission_id: string; p_user_id: string };
        Returns: {
          case_id: string;
          case_status: string;
          inbound_token: string;
          mission_status: string;
        }[];
      };
      claim_auction_sale_market_estimate: {
        Args: {
          p_auction_sale_id: string;
          p_lease_seconds?: number;
          p_now?: string;
        };
        Returns: Json;
      };
      claim_auction_sale_market_estimates: {
        Args: {
          p_lease_seconds?: number;
          p_limit?: number;
          p_now?: string;
        };
        Returns: Json;
      };
      enqueue_auction_sale_market_estimate: {
        Args: {
          p_auction_sale_id: string;
          p_now?: string;
          p_priority?: number;
          p_reason?: string;
        };
        Returns: Json;
      };
      evaluate_market_valuation_health: {
        Args: { p_now?: string };
        Returns: Json;
      };
      grant_analysis_access_from_checkout: {
        Args: {
          p_amount_total: number | null;
          p_checkout_session_id: string;
          p_currency: string | null;
          p_duration_days?: number;
          p_paid_at: string;
          p_stripe_customer_id: string | null;
          p_user_id: string;
        };
        Returns: {
          access_end: string;
          granted: boolean;
        }[];
      };
      search_auction_sales_preview: {
        Args: {
          p_city?: string | null;
          p_departments?: string[] | null;
          p_east?: number | null;
          p_keywords?: string[] | null;
          p_limit?: number;
          p_max_price?: number | null;
          p_max_surface?: number | null;
          p_min_bathrooms?: number | null;
          p_min_bedrooms?: number | null;
          p_min_price?: number | null;
          p_min_score?: number | null;
          p_min_surface?: number | null;
          p_north?: number | null;
          p_occupancy_status?: string | null;
          p_offset?: number;
          p_postal_code?: string | null;
          p_property_types?: string[] | null;
          p_sort?: string;
          p_south?: number | null;
          p_statuses?: string[] | null;
          p_tribunal?: string | null;
          p_west?: number | null;
        };
        Returns: {
          id: string;
          starting_price_eur: number | null;
          total_count: number;
        }[];
      };
      search_auction_sales_preview_v2: {
        Args: {
          p_sale_venue_type?: string | null;
          p_city?: string | null;
          p_departments?: string[] | null;
          p_east?: number | null;
          p_keywords?: string[] | null;
          p_limit?: number;
          p_max_price?: number | null;
          p_max_surface?: number | null;
          p_min_bathrooms?: number | null;
          p_min_bedrooms?: number | null;
          p_min_price?: number | null;
          p_min_score?: number | null;
          p_min_surface?: number | null;
          p_north?: number | null;
          p_occupancy_status?: string | null;
          p_offset?: number;
          p_postal_code?: string | null;
          p_property_types?: string[] | null;
          p_sort?: string;
          p_south?: number | null;
          p_statuses?: string[] | null;
          p_tribunal?: string | null;
          p_west?: number | null;
        };
        Returns: {
          id: string;
          starting_price_eur: number | null;
          sale_venue_type: string;
          sale_verification_status: string;
          total_count: number;
        }[];
      };
      search_auction_sales_preview_v3: {
        Args: {
          p_sale_venue_type?: string | null;
          p_city?: string | null;
          p_departments?: string[] | null;
          p_east?: number | null;
          p_keywords?: string[] | null;
          p_limit?: number;
          p_max_price?: number | null;
          p_max_surface?: number | null;
          p_min_bathrooms?: number | null;
          p_min_bedrooms?: number | null;
          p_min_price?: number | null;
          p_min_score?: number | null;
          p_min_surface?: number | null;
          p_north?: number | null;
          p_occupancy_status?: string | null;
          p_offset?: number;
          p_postal_code?: string | null;
          p_property_types?: string[] | null;
          p_sort?: string;
          p_south?: number | null;
          p_statuses?: string[] | null;
          p_tribunal?: string | null;
          p_west?: number | null;
        };
        Returns: {
          id: string;
          starting_price_eur: number | null;
          sale_venue_type: string;
          sale_verification_status: string;
          total_count: number;
          city: string | null;
          department: string | null;
          property_type: string | null;
          sale_date: string | null;
          app_surface_m2: number | null;
          app_surface_kind: string | null;
          rooms_count: number | null;
          bedrooms_count: number | null;
          bathrooms_count: number | null;
          latitude: number | null;
          longitude: number | null;
          thumbnail_url: string | null;
        }[];
      };
      search_dvf_market_comparables: {
        Args: {
          p_latitude: number;
          p_limit?: number;
          p_longitude: number;
          p_minimum_date: string;
          p_radius_m: number;
          p_segment: string;
        };
        Returns: {
          built_surface_m2: number | null;
          distance_m: number;
          dvf_property_type_code: string | null;
          id: string;
          land_surface_m2: number | null;
          latitude: number;
          longitude: number;
          mutation_nature: string | null;
          parcel_id: string | null;
          price_per_m2: number | null;
          property_type: string | null;
          sale_date: string;
          source_mutation_id: string;
          total_price_eur: number;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
