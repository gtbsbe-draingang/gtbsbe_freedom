from pydantic import BaseModel, Field, model_validator

from app.models import Answer


class ReferenceLabel(BaseModel):
    conversation_id: str
    criterion_id: str
    answer: Answer
    kinds: list[str] = Field(default_factory=list)
    note: str = ""
    disputed: bool = False


class ReferenceSet(BaseModel):
    checklist_id: str
    version: int
    labels: list[ReferenceLabel]

    @model_validator(mode="after")
    def unique_labels(self):
        keys = [(x.conversation_id, x.criterion_id) for x in self.labels]
        if len(keys) != len(set(keys)):
            raise ValueError("Duplicate reference labels")
        return self


class AgreementCell(BaseModel):
    agreement: float | None = Field(default=None, ge=0, le=1)
    n: int = Field(ge=0)

    @model_validator(mode="after")
    def agreement_requires_observations(self):
        if (self.agreement is None) != (self.n == 0):
            raise ValueError("agreement must be null exactly when n is zero")
        return self


class AccuracyReport(BaseModel):
    reference_note: str
    model: str
    overall: AgreementCell
    by_criterion: list[dict]
    by_language: list[dict]
    by_channel: list[dict]
    missing: int
    disputed_excluded: int
    disagreements: list[dict]
