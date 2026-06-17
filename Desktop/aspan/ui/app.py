from __future__ import annotations

from pathlib import Path

import streamlit as st

from core.calc_engine import calculate_proposal
from core.config_loader import load_config
from core.extraction import extract_multiple_bills
from core.models import BillData, ClientInfo
from core.pipeline import generate_proposal_artifacts
from core.utils import ensure_dir, format_currency, format_kwp, format_number


st.set_page_config(
    page_title="Aspan Proposal Engine",
    page_icon=None,
    layout="wide",
    initial_sidebar_state="expanded",
)


st.markdown(
    """
    <style>
    :root {
      --aspan-ink: #173b33;
      --aspan-text: #1f2933;
      --aspan-muted: #62716c;
      --aspan-teal: #00a884;
      --aspan-amber: #f4b942;
      --aspan-paper: #f7faf8;
      --aspan-line: #d7e3de;
    }
    .stApp {
      background:
        repeating-linear-gradient(135deg, rgba(0,168,132,0.035) 0, rgba(0,168,132,0.035) 1px, transparent 1px, transparent 12px),
        linear-gradient(180deg, #fbfdfb 0%, #eef6f2 100%);
      color: var(--aspan-text);
    }
    [data-testid="stSidebar"] {
      background: #163b33;
      color: white;
      border-right: 4px solid var(--aspan-amber);
    }
    [data-testid="stSidebar"] * { color: white; }
    h1, h2, h3 { color: var(--aspan-ink); letter-spacing: 0; }
    div[data-testid="stMetric"] {
      background: rgba(255,255,255,0.82);
      border: 1px solid var(--aspan-line);
      border-left: 4px solid var(--aspan-teal);
      padding: 0.65rem 0.8rem;
    }
    .stButton > button, .stDownloadButton > button {
      background: var(--aspan-ink);
      color: white;
      border: 1px solid var(--aspan-ink);
      border-radius: 6px;
      min-height: 42px;
      font-weight: 700;
    }
    .stButton > button:hover, .stDownloadButton > button:hover {
      background: #0f2b25;
      color: white;
      border-color: var(--aspan-amber);
    }
    div[data-testid="stAlert"] {
      border-radius: 6px;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


@st.cache_resource
def get_config():
    return load_config()


def save_uploads(uploaded_files) -> list[str]:
    upload_dir = ensure_dir("cache/uploads")
    paths: list[str] = []
    for uploaded in uploaded_files:
        target = upload_dir / Path(uploaded.name).name
        target.write_bytes(uploaded.getbuffer())
        paths.append(str(target))
    return paths


def bill_from_form() -> BillData:
    return BillData(
        monthly_kwh=st.session_state["bill_monthly_kwh"],
        currency=st.session_state["bill_currency"],
        total_cost=st.session_state["bill_total_cost"],
        tariff_per_kwh=st.session_state["bill_tariff"],
        billing_period_start=st.session_state.get("bill_period_start"),
        billing_period_end=st.session_state.get("bill_period_end"),
        extraction_notes=st.session_state.get("bill_notes", "").splitlines(),
        field_confidence=st.session_state.get("bill_confidence", {}),
    )


def client_from_form() -> ClientInfo:
    latitude = st.session_state.get("latitude")
    longitude = st.session_state.get("longitude")
    ppa_override = st.session_state.get("ppa_tariff_per_kwh_override")
    diesel_override = st.session_state.get("diesel_price_per_liter_override")
    return ClientInfo(
        client_name=st.session_state["client_name"],
        industry=st.session_state["industry"],
        country=st.session_state["country"],
        city=st.session_state.get("city") or None,
        latitude=None if latitude == 0 else latitude,
        longitude=None if longitude == 0 else longitude,
        business_description=st.session_state.get("business_description") or None,
        has_diesel_generators=st.session_state["has_diesel_generators"],
        grid_connection_kva=st.session_state.get("grid_connection_kva"),
        available_roof_area_m2=st.session_state.get("available_roof_area_m2"),
        daytime_fraction_override=st.session_state.get("daytime_fraction_override"),
        ppa_tariff_per_kwh_override=None if ppa_override == 0 else ppa_override,
        diesel_price_per_liter_override=None if diesel_override == 0 else diesel_override,
    )


config = get_config()

with st.sidebar:
    st.title("Aspan")
    st.caption("Proposal Engine")
    st.divider()
    st.write("Deterministic Python owns the calculations.")
    st.write("Claude is limited to extraction and prose.")
    st.write("Streamlit is the local demo UI.")

st.title("Aspan Proposal Engine")
st.caption("Upload bills, confirm assumptions, preview economics, and generate an editable PowerPoint proposal.")

left, right = st.columns([0.95, 1.05], gap="large")

with left:
    st.subheader("Bill Upload")
    uploaded_files = st.file_uploader(
        "Utility bills",
        type=["pdf", "png", "jpg", "jpeg"],
        accept_multiple_files=True,
    )
    extract_clicked = st.button("Extract Bill Data", use_container_width=True)
    if extract_clicked:
        paths = save_uploads(uploaded_files or [])
        bill = extract_multiple_bills(paths, config)
        st.session_state["extracted_bill"] = bill
        st.session_state["bill_monthly_kwh"] = float(bill.monthly_kwh)
        st.session_state["bill_currency"] = bill.currency
        st.session_state["bill_total_cost"] = float(bill.total_cost)
        st.session_state["bill_tariff"] = float(bill.tariff_per_kwh)
        st.session_state["bill_period_start"] = bill.billing_period_start
        st.session_state["bill_period_end"] = bill.billing_period_end
        st.session_state["bill_notes"] = "\n".join(bill.extraction_notes)
        st.session_state["bill_confidence"] = bill.field_confidence
        st.success("Bill data extracted. Review and edit before generating.")

    default_bill = st.session_state.get(
        "extracted_bill",
        BillData(
            monthly_kwh=10000,
            currency="USD",
            total_cost=2000,
            tariff_per_kwh=0.20,
            billing_period_start=None,
            billing_period_end=None,
            extraction_notes=["Demo defaults loaded. Replace with extracted or confirmed bill data."],
            field_confidence={"monthly_kwh": 0.5, "total_cost": 0.5, "tariff_per_kwh": 0.5},
        ),
    )

    st.subheader("Parsed Bill Review")
    st.number_input("Monthly kWh", min_value=0.01, value=float(default_bill.monthly_kwh), key="bill_monthly_kwh")
    col_a, col_b = st.columns(2)
    with col_a:
        st.text_input("Currency", value=default_bill.currency, key="bill_currency")
        st.date_input("Billing period start", value=default_bill.billing_period_start, key="bill_period_start")
    with col_b:
        st.number_input("Total cost", min_value=0.0, value=float(default_bill.total_cost), key="bill_total_cost")
        st.date_input("Billing period end", value=default_bill.billing_period_end, key="bill_period_end")
    st.number_input("Tariff per kWh", min_value=0.0, value=float(default_bill.tariff_per_kwh), format="%.4f", key="bill_tariff")
    st.text_area("Extraction notes", value="\n".join(default_bill.extraction_notes), height=100, key="bill_notes")

with right:
    st.subheader("Client Information")
    st.text_input("Client name", value=st.session_state.get("client_name", "Neskao"), key="client_name")
    c1, c2, c3 = st.columns(3)
    with c1:
        st.selectbox(
            "Industry",
            ["manufacturing", "cold_storage", "food_processing", "retail", "hospitality"],
            index=2,
            key="industry",
        )
    with c2:
        st.selectbox("Country", ["Ghana", "Nigeria", "Senegal", "Cote d'Ivoire"], index=0, key="country")
    with c3:
        st.text_input("City", value=st.session_state.get("city", "Accra"), key="city")

    st.text_area("Business description", value=st.session_state.get("business_description", ""), height=80, key="business_description")
    st.checkbox("Has diesel generators", value=st.session_state.get("has_diesel_generators", True), key="has_diesel_generators")

    st.subheader("Assumptions Review")
    a1, a2, a3 = st.columns(3)
    with a1:
        st.number_input("Grid connection kVA", min_value=0.0, value=600.0, key="grid_connection_kva")
        st.number_input("Latitude", value=0.0, key="latitude", format="%.4f")
    with a2:
        st.number_input("Available roof area m2", min_value=0.0, value=4000.0, key="available_roof_area_m2")
        st.number_input("Longitude", value=0.0, key="longitude", format="%.4f")
    with a3:
        st.number_input("Daytime fraction override", min_value=0.0, max_value=1.0, value=0.75, key="daytime_fraction_override")
        st.number_input("PPA tariff override", min_value=0.0, value=0.0, format="%.4f", key="ppa_tariff_per_kwh_override")
        st.number_input("Diesel price per liter override", min_value=0.0, value=0.0, format="%.4f", key="diesel_price_per_liter_override")

bill = bill_from_form()
client = client_from_form()
calc = calculate_proposal(bill, client, config)

st.subheader("Calculation Preview")
m1, m2, m3, m4 = st.columns(4)
m1.metric("Recommended system", format_kwp(calc.pv_recommendation.recommended_kwp))
m2.metric("Binding constraint", calc.pv_recommendation.binding_constraint)
m3.metric("Annual production", f"{format_number(calc.annual_solar_production_kwh)} kWh")
m4.metric("PPA tariff", format_currency(calc.ppa_tariff_per_kwh, bill.currency, 3))

s1, s2 = st.columns(2)
with s1:
    st.markdown("**Scenario 1: Grid Replacement**")
    st.write(f"Monthly savings: {format_currency(calc.scenario_grid_replacement.monthly_savings_year_1, bill.currency)}")
    st.write(f"Annual savings: {format_currency(calc.scenario_grid_replacement.annual_savings_year_1, bill.currency)}")
    st.write(f"{config.analysis_horizon_years}-year savings: {format_currency(calc.scenario_grid_replacement.cumulative_savings, bill.currency)}")
with s2:
    st.markdown("**Scenario 2: Grid + Diesel**")
    st.write(f"Monthly savings: {format_currency(calc.scenario_grid_diesel.monthly_savings_year_1, bill.currency)}")
    st.write(f"Annual savings: {format_currency(calc.scenario_grid_diesel.annual_savings_year_1, bill.currency)}")
    st.write(f"{config.analysis_horizon_years}-year savings: {format_currency(calc.scenario_grid_diesel.cumulative_savings, bill.currency)}")

if calc.warnings:
    st.warning("\n".join(calc.warnings))

st.subheader("Proposal Generation")
if st.button("Generate Proposal", use_container_width=True):
    response = generate_proposal_artifacts(bill, client, config)
    st.session_state["proposal_path"] = response.output_pptx_path
    st.session_state["proposal_warnings"] = response.warnings
    st.success("Editable PowerPoint proposal generated.")

if st.session_state.get("proposal_warnings"):
    st.info("\n".join(st.session_state["proposal_warnings"]))

proposal_path = st.session_state.get("proposal_path")
if proposal_path and Path(proposal_path).exists():
    with Path(proposal_path).open("rb") as handle:
        st.download_button(
            "Download PowerPoint",
            handle,
            file_name=Path(proposal_path).name,
            mime="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            use_container_width=True,
        )
