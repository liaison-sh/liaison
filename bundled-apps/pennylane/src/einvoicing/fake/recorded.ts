// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane v2 answers recorded from the sandbox company (2026-10-15) for the shapes the fake
// replays: customers, the directory's electronic billing addresses, the Factur-X import and its
// validation, invoice list filters, bookings, file attachments, webhook subscriptions, a supplier
// invoice import (reception has no sandbox sample: its e_invoicing block is fake-only), and the
// exact error bodies (422 reference taken, 409 already imported, 422 not an e-invoice, 400 VAT
// rate enum). Parties are fictional; signed URLs, the webhook secret and directory suffixes are
// redacted. The fake fills ids and values; the drift test compares these shapes with the live
// sandbox.

export const RECORDED = {
  "paRegistrations": {
    "status": 200,
    "body": {
      "items": [],
      "emission_activated": false,
      "has_more": false,
      "next_cursor": null
    }
  },
  "emptyPage": {
    "status": 200,
    "body": {
      "items": [],
      "has_more": false,
      "next_cursor": null
    }
  },
  "customerCompany": {
    "status": 201,
    "body": {
      "billing_iban": null,
      "created_at": "2026-10-15T07:37:24.918513Z",
      "customer_type": "company",
      "id": 1587269591040,
      "name": "Client Exemple SARL",
      "payment_conditions": "30_days",
      "phone": "",
      "recipient": "",
      "reference": "",
      "updated_at": "2026-10-15T07:37:24.918411Z",
      "billing_language": "fr_FR",
      "vat_number": "FR83900000001",
      "reg_no": "900000001",
      "electronic_billing_address": null,
      "ledger_account": {
        "id": 16786164424704
      },
      "notes": null,
      "emails": [],
      "billing_address": {
        "address": "2 avenue du Test",
        "postal_code": "69002",
        "city": "Lyon",
        "country_alpha2": "FR"
      },
      "delivery_address": {
        "address": "",
        "postal_code": "",
        "city": "",
        "country_alpha2": ""
      },
      "external_reference": "probe-contact-1",
      "mandates": {
        "url": "https://app.pennylane.com/api/external/v2/gocardless_mandates?filter=%5B%7B%22field%22%3A%22customer_id%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%221587269591040%22%7D%5D"
      },
      "pro_account_mandates": {
        "url": "https://app.pennylane.com/api/external/v2/pro_account/mandates?filter=%5B%7B%22field%22%3A%22customer_id%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%221587269591040%22%7D%5D"
      },
      "contacts": {
        "url": "https://app.pennylane.com/api/external/v2/customers/1587269591040/contacts"
      }
    }
  },
  "errorExternalReferenceTaken": {
    "status": 422,
    "body": {
      "status": 422,
      "error": "External reference has already been taken"
    }
  },
  "electronicBillingAddresses": {
    "status": 200,
    "body": {
      "items": [
        {
          "electronic_billing_address": "900000001_SVC1"
        },
        {
          "electronic_billing_address": "900000001"
        },
        {
          "electronic_billing_address": "900000001_SVC2"
        }
      ],
      "has_more": false,
      "next_cursor": null
    }
  },
  "customerIndividual": {
    "status": 201,
    "body": {
      "billing_iban": null,
      "created_at": "2026-10-15T07:37:34.791311Z",
      "customer_type": "individual",
      "id": 1587270578176,
      "name": "Alex Exemple",
      "payment_conditions": "30_days",
      "phone": "",
      "recipient": "",
      "reference": "",
      "updated_at": "2026-10-15T07:37:34.791216Z",
      "billing_language": "fr_FR",
      "last_name": "Exemple",
      "first_name": "Alex",
      "ledger_account": {
        "id": 16786165039104
      },
      "notes": null,
      "emails": [],
      "billing_address": {
        "address": "3 rue Test",
        "postal_code": "75011",
        "city": "Paris",
        "country_alpha2": "FR"
      },
      "delivery_address": {
        "address": "",
        "postal_code": "",
        "city": "",
        "country_alpha2": ""
      },
      "external_reference": "probe-contact-2",
      "mandates": {
        "url": "https://app.pennylane.com/api/external/v2/gocardless_mandates?filter=%5B%7B%22field%22%3A%22customer_id%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%221587270578176%22%7D%5D"
      },
      "pro_account_mandates": {
        "url": "https://app.pennylane.com/api/external/v2/pro_account/mandates?filter=%5B%7B%22field%22%3A%22customer_id%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%221587270578176%22%7D%5D"
      },
      "contacts": {
        "url": "https://app.pennylane.com/api/external/v2/customers/1587270578176/contacts"
      }
    }
  },
  "errorEbaNotEligible": {
    "status": 422,
    "body": {
      "status": 422,
      "error": "The electronic billing address is not eligible for this customer"
    }
  },
  "einvoiceImportCreated": {
    "status": 201,
    "body": {
      "id": 32369341468672,
      "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672"
    }
  },
  "einvoiceValid": {
    "status": 200,
    "body": {
      "id": 32369341468672,
      "label": "Facture Client Exemple SARL - PRB-0001 (label généré)",
      "invoice_number": "PRB-0001",
      "currency": "EUR",
      "amount": "926.29",
      "currency_amount": "926.29",
      "currency_amount_before_tax": "776.98",
      "tax": "149.31",
      "currency_tax": "149.31",
      "remaining_amount_with_tax": "926.29",
      "remaining_amount_without_tax": "776.98",
      "draft": false,
      "language": "fr_FR",
      "paid": false,
      "status": "incomplete",
      "filename": "PRB-0001.pdf",
      "date": "2026-10-15",
      "deadline": "2026-10-15",
      "special_mention": null,
      "created_at": "2026-10-15T07:37:42.943099Z",
      "updated_at": "2026-10-15T07:37:43.949456Z",
      "archived_at": null,
      "schematron_validation_status": "valid",
      "purchase_order_reference": null,
      "sale_type": null,
      "pdf_invoice_free_text": "",
      "pdf_description": null,
      "pdf_invoice_subject": "",
      "public_file_url": "https://app.pennylane.com/public/invoice/pdf?encrypted_id=REDACTED",
      "exchange_rate": "1.0",
      "discount": {
        "type": "relative",
        "value": "0.0"
      },
      "ledger_entry": {
        "id": 32369341468672
      },
      "customer_invoice_template": null,
      "transaction_reference": null,
      "customer": {
        "id": 1587269591040,
        "url": "https://app.pennylane.com/api/external/v2/customers/1587269591040"
      },
      "payment_method_ledger_account": null,
      "billing_subscription": null,
      "credited_invoice": null,
      "quote": null,
      "invoice_line_sections": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/invoice_line_sections"
      },
      "invoice_lines": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/invoice_lines"
      },
      "custom_header_fields": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/custom_header_fields"
      },
      "categories": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/categories"
      },
      "payments": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/payments"
      },
      "matched_transactions": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/matched_transactions"
      },
      "appendices": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/appendices"
      },
      "installments": null,
      "external_reference": "NCLQ2YU6TC",
      "sales_order_reference": null,
      "e_invoicing": null,
      "factur_x": true
    }
  },
  "invoicePage": {
    "status": 200,
    "body": {
      "items": [
        {
          "id": 32369341468672,
          "label": "Facture Client Exemple SARL - PRB-0001 (label généré)",
          "invoice_number": "PRB-0001",
          "currency": "EUR",
          "amount": "926.29",
          "currency_amount": "926.29",
          "currency_amount_before_tax": "776.98",
          "tax": "149.31",
          "currency_tax": "149.31",
          "remaining_amount_with_tax": "926.29",
          "remaining_amount_without_tax": "776.98",
          "draft": false,
          "language": "fr_FR",
          "paid": false,
          "status": "incomplete",
          "filename": "PRB-0001.pdf",
          "date": "2026-10-15",
          "deadline": "2026-10-15",
          "special_mention": null,
          "created_at": "2026-10-15T07:37:42.943099Z",
          "updated_at": "2026-10-15T07:37:43.949456Z",
          "archived_at": null,
          "schematron_validation_status": "valid",
          "purchase_order_reference": null,
          "sale_type": null,
          "pdf_invoice_free_text": "",
          "pdf_description": null,
          "pdf_invoice_subject": "",
          "public_file_url": "https://app.pennylane.com/public/invoice/pdf?encrypted_id=REDACTED",
          "exchange_rate": "1.0",
          "discount": {
            "type": "relative",
            "value": "0.0"
          },
          "ledger_entry": {
            "id": 32369341468672
          },
          "customer_invoice_template": null,
          "transaction_reference": null,
          "customer": {
            "id": 1587269591040,
            "url": "https://app.pennylane.com/api/external/v2/customers/1587269591040"
          },
          "payment_method_ledger_account": null,
          "billing_subscription": null,
          "credited_invoice": null,
          "quote": null,
          "invoice_line_sections": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/invoice_line_sections"
          },
          "invoice_lines": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/invoice_lines"
          },
          "custom_header_fields": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/custom_header_fields"
          },
          "categories": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/categories"
          },
          "payments": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/payments"
          },
          "matched_transactions": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/matched_transactions"
          },
          "appendices": {
            "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369341468672/appendices"
          },
          "installments": null,
          "external_reference": "NCLQ2YU6TC",
          "sales_order_reference": null,
          "e_invoicing": null,
          "factur_x": true
        }
      ],
      "has_more": false,
      "next_cursor": null
    }
  },
  "errorAlreadyImported": {
    "status": 409,
    "body": {
      "status": 409,
      "error": "A document with ID 32369341468672 already exists with such attachment."
    }
  },
  "fileAttachmentCreated": {
    "status": 201,
    "body": {
      "id": 101992419328,
      "filename": "BK-0001.pdf",
      "created_at": "2026-10-15T07:38:30.705433Z",
      "updated_at": "2026-10-15T07:38:30.718097Z",
      "url": "https://app.pennylane.com/rails/active_storage/blobs/redirect/REDACTED/BK-0001.pdf"
    }
  },
  "errorVatRateEnum": {
    "status": 400,
    "body": {
      "message": "The invoice_lines.vat_rate's value (NOT_A_RATE) isn't part of the enum: FR_1_05,FR_1_75,FR_09,FR_21,FR_40,FR_50,FR_55,FR_60,FR_65,FR_85,FR_92,FR_100,FR_130,FR_15_385,FR_160,FR_196,FR_200,AD_10,AD_45,AD_95,AT_100,AT_130,AT_190,AT_200,BE_60,BE_120,BE_210,BG_90,BG_200,CH_25,CH_37,CH_77,CH_26,CH_38,CH_81,CY_30,CY_50,CY_80,CY_90,CY_190,CZ_100,CZ_120,CZ_150,CZ_210,DE_70,DE_190,DK_250,EE_90,EE_200,EE_220,EE_240,ES_40,ES_70,ES_100,ES_210,FI_100,FI_135,FI_140,FI_240,FI_255,GB_50,GB_200,GR_60,GR_130,GR_170,GR_240,GR_40,HR_50,HR_130,HR_250,HU_50,HU_180,HU_270,IE_48,IE_90,IE_135,IE_210,IE_230,IT_40,IT_50,IT_100,IT_220,LT_50,LT_90,LT_120,LT_210,LU_30,LU_70,LU_80,LU_120,LU_130,LU_140,LU_160,LU_170,LV_50,LV_120,LV_210,MC_09,MC_21,MC_55,MC_85,MC_100,MC_200,MT_50,MT_70,MT_120,MT_180,MU_150,NL_90,NL_210,PL_50,PL_80,PL_230,PT_60,PT_130,PT_160,PT_180,PT_220,PT_230,RO_50,RO_90,RO_110,RO_190,RO_210,SE_60,SE_120,SE_250,SI_50,SI_95,SI_220,SK_50,SK_100,SK_190,SK_200,SK_230,NO_120,NO_150,NO_250,DE_70_BU0002,DE_190_BU0003,DE_70_BU0008,DE_190_BU0009,DE_intracom_70_BU0012,DE_intracom_190_BU0013,DE_190_electronic_BU0226,exempt,DE_intracom_exempt_BU0011,DE_intracom_exempt_BU0047,DE_intracom_exempt_BU0233,DE_exempt_BU0001,DE_exempt_BU0181,DE_exempt_BU0490,intracom_21,intracom_55,intracom_85,intracom_100,crossborder,ES_intracom_sales_goods,ES_intracom_sales_services,DE_intracom_70_BU0018,DE_intracom_190_BU0019,DE_intracom_190_BU0506,extracom,DE_extracom_BU0173,DE_extracom_BU0191,DE_extracom_190_BU0511,ES_isp_sales,FR_85_construction,FR_100_construction,FR_200_construction,DE_exempt_construction_BU0046,DE_70_construction_BU0091,DE_190_construction_BU0094,DE_190_construction_BU0526,DE_190_construction_BU0546,mixed.",
      "code": "NotEnumInclude",
      "field": "invoice_lines.vat_rate",
      "payload": "\"NOT_A_RATE\""
    }
  },
  "bookingCreated": {
    "status": 201,
    "body": {
      "id": 32369471922176,
      "label": "Facture Alex Exemple - BK-0001 (label généré)",
      "invoice_number": "BK-0001",
      "currency": "EUR",
      "amount": "120.0",
      "currency_amount": "120.0",
      "currency_amount_before_tax": "100.0",
      "tax": "20.0",
      "currency_tax": "20.0",
      "remaining_amount_with_tax": "120.0",
      "remaining_amount_without_tax": "100.0",
      "draft": false,
      "language": "fr_FR",
      "paid": false,
      "status": "upcoming",
      "filename": "BK-0001.pdf",
      "date": "2026-10-15",
      "deadline": "2026-10-15",
      "pdf_invoice_free_text": "",
      "pdf_invoice_subject": "",
      "pdf_description": null,
      "special_mention": null,
      "created_at": "2026-10-15T07:38:47.298712Z",
      "updated_at": "2026-10-15T07:38:47.604136Z",
      "archived_at": null,
      "schematron_validation_status": null,
      "purchase_order_reference": null,
      "sale_type": null,
      "public_file_url": "https://app.pennylane.com/public/invoice/pdf?encrypted_id=REDACTED",
      "exchange_rate": "1.0",
      "discount": {
        "type": "relative",
        "value": "0.0"
      },
      "ledger_entry": {
        "id": 32369471922176
      },
      "customer_invoice_template": null,
      "transaction_reference": null,
      "customer": {
        "id": 1587270578176,
        "url": "https://app.pennylane.com/api/external/v2/customers/1587270578176"
      },
      "payment_method_ledger_account": null,
      "billing_subscription": null,
      "credited_invoice": null,
      "quote": null,
      "invoice_line_sections": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/invoice_line_sections"
      },
      "invoice_lines": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/invoice_lines"
      },
      "custom_header_fields": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/custom_header_fields"
      },
      "categories": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/categories"
      },
      "payments": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/payments"
      },
      "matched_transactions": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/matched_transactions"
      },
      "appendices": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369471922176/appendices"
      },
      "installments": null,
      "external_reference": "probe-book-0001",
      "sales_order_reference": null,
      "e_invoicing": null,
      "factur_x": false
    }
  },
  "errorBookingExternalReferenceTaken": {
    "status": 422,
    "body": {
      "status": 422,
      "error": "External reference has already been taken"
    }
  },
  "einvoiceInvalid": {
    "status": 200,
    "body": {
      "id": 32369515302912,
      "label": "Facture Client Exemple SARL - PRB-0004 (label généré)",
      "invoice_number": "PRB-0004",
      "currency": "EUR",
      "amount": "926.29",
      "currency_amount": "926.29",
      "currency_amount_before_tax": "776.98",
      "tax": "149.31",
      "currency_tax": "149.31",
      "remaining_amount_with_tax": "926.29",
      "remaining_amount_without_tax": "776.98",
      "draft": false,
      "language": "fr_FR",
      "paid": false,
      "status": "incomplete",
      "filename": "PRB-0004.pdf",
      "date": "2026-10-15",
      "deadline": "2026-10-15",
      "special_mention": null,
      "created_at": "2026-10-15T07:39:05.660758Z",
      "updated_at": "2026-10-15T07:39:06.921716Z",
      "archived_at": null,
      "schematron_validation_status": "invalid",
      "purchase_order_reference": null,
      "sale_type": null,
      "pdf_invoice_free_text": "",
      "pdf_description": null,
      "pdf_invoice_subject": "",
      "public_file_url": "https://app.pennylane.com/public/invoice/pdf?encrypted_id=REDACTED",
      "exchange_rate": "1.0",
      "discount": {
        "type": "relative",
        "value": "0.0"
      },
      "ledger_entry": {
        "id": 32369515302912
      },
      "customer_invoice_template": null,
      "transaction_reference": null,
      "customer": {
        "id": 1587276500992,
        "url": "https://app.pennylane.com/api/external/v2/customers/1587276500992"
      },
      "payment_method_ledger_account": null,
      "billing_subscription": null,
      "credited_invoice": null,
      "quote": null,
      "invoice_line_sections": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/invoice_line_sections"
      },
      "invoice_lines": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/invoice_lines"
      },
      "custom_header_fields": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/custom_header_fields"
      },
      "categories": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/categories"
      },
      "payments": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/payments"
      },
      "matched_transactions": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/matched_transactions"
      },
      "appendices": {
        "url": "https://app.pennylane.com/api/external/v2/customer_invoices/32369515302912/appendices"
      },
      "installments": null,
      "external_reference": "ZL7WRFTMSC",
      "sales_order_reference": null,
      "e_invoicing": null,
      "factur_x": true
    }
  },
  "errorNotAnEinvoice": {
    "status": 422,
    "body": {
      "status": 422,
      "error": "The file provided is not a valid e-invoice (Factur-X PDF, UBL or CII XML)."
    }
  },
  "webhookSubscriptionCreated": {
    "status": 201,
    "body": {
      "id": 4704,
      "callback_url": "https://example.com/liaison-probe",
      "events": [
        "customer_invoice.e_invoicing_status_updated",
        "supplier_invoice.e_invoicing_received"
      ],
      "enabled": false,
      "secret": "<redacted-36-chars>",
      "created_at": "2026-10-15T07:39:17.873002Z",
      "updated_at": "2026-10-15T07:39:17.872870Z"
    }
  },
  "supplierInvoiceImported": {
    "status": 201,
    "body": {
      "amount": "120.0",
      "archived_at": null,
      "created_at": "2026-10-15T09:15:58.404517Z",
      "currency_amount_before_tax": "100.0",
      "currency_amount": "120.0",
      "currency_tax": "20.0",
      "currency": "EUR",
      "date": "2026-10-14",
      "deadline": "2026-11-13",
      "filename": "probe-bill.pdf",
      "id": 32384166563840,
      "invoice_number": "PROBE-SUP-1",
      "label": "Facture Fournisseur Exemple - PROBE-SUP-1 (label généré)",
      "payment_status": "to_be_processed",
      "paid": false,
      "remaining_amount_with_tax": "-120.0",
      "remaining_amount_without_tax": "-100.0",
      "tax": "20.0",
      "updated_at": "2026-10-15T09:15:58.721789Z",
      "reconciled": false,
      "public_file_url": "https://app.pennylane.com/public/invoice/pdf?encrypted_id=<redacted>",
      "exchange_rate": "1.0",
      "accounting_status": "complete",
      "ledger_entry": {
        "id": 32384166563840
      },
      "transaction_reference": null,
      "supplier": {
        "id": 1585214119936,
        "url": "https://app.pennylane.com/api/external/v2/suppliers/1585214119936"
      },
      "payment_method_ledger_account": null,
      "invoice_lines": {
        "url": "https://app.pennylane.com/api/external/v2/supplier_invoices/32384166563840/invoice_lines"
      },
      "categories": {
        "url": "https://app.pennylane.com/api/external/v2/supplier_invoices/32384166563840/categories"
      },
      "payments": {
        "url": "https://app.pennylane.com/api/external/v2/supplier_invoices/32384166563840/payments"
      },
      "matched_transactions": {
        "url": "https://app.pennylane.com/api/external/v2/supplier_invoices/32384166563840/matched_transactions"
      },
      "external_reference": "probe-sup-1",
      "import_source": null,
      "e_invoicing": null,
      "performance_date": null
    }
  },
  "supplier": {
    "status": 200,
    "body": {
      "created_at": "2026-10-14T14:14:29.736569Z",
      "establishment_no": null,
      "reg_no": "",
      "iban": "",
      "id": 1585214119936,
      "name": "Fournisseur Exemple",
      "supplier_payment_method": null,
      "supplier_due_date_delay": null,
      "supplier_due_date_rule": "days",
      "updated_at": "2026-10-14T14:14:29.726410Z",
      "vat_number": "",
      "ledger_account": {
        "id": 16774290984960
      },
      "emails": [],
      "postal_address": {
        "address": "",
        "postal_code": "",
        "city": "",
        "country_alpha2": "FR"
      },
      "external_reference": "01a13ac3-c042-7a46-96c6-b947172a1984"
    }
  },
  "errorSupplierAttachmentTaken": {
    "status": 409,
    "body": {
      "status": 409,
      "error": "A document with ID 32384166563840 already exists with such attachment."
    }
  },
  "errorSupplierNameFilter": {
    "status": 400,
    "body": {
      "status": 400,
      "error": "Operator \"eq\" is not allowed for filter field \"name\".\nAllowed operators are \"start_with\"\n"
    }
  }
} as const

export type RecordedKey = keyof typeof RECORDED
