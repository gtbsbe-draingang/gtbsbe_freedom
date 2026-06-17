from __future__ import annotations

from core.calc_engine import calculate_proposal
from core.config_loader import AppConfig
from core.facts_pack import load_facts_pack
from core.models import BillData, ClientInfo, ProposalResponse
from core.narrative import generate_narrative
from core.pptx_builder import build_pptx
from core.proposal_log import append_proposal_log
from core.style_reference import select_style_reference


def generate_proposal_artifacts(
    bill: BillData,
    client: ClientInfo,
    config: AppConfig,
) -> ProposalResponse:
    calc = calculate_proposal(bill, client, config)
    facts = load_facts_pack(client)
    style = select_style_reference(client)
    narrative = generate_narrative(
        bill=bill,
        client=client,
        calc=calc,
        facts_pack_text=facts.text,
        style_reference=style.text,
        config=config,
    )
    output_path = build_pptx(bill, client, calc, narrative, config)
    append_proposal_log(
        client=client,
        bill=bill,
        calc=calc,
        output_pptx_path=output_path,
        facts_pack_files_used=facts.files_used,
        style_reference_used=style.file_used,
        config=config,
    )
    warnings = calc.warnings + facts.warnings + style.warnings
    return ProposalResponse(
        output_pptx_path=output_path,
        calc_result=calc,
        narrative=narrative,
        warnings=warnings,
    )

