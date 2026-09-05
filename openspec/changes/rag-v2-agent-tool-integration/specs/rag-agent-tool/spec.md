## ADDED Requirements

### Requirement: RAG Tool is opt-in

DKAgent SHALL register the knowledge-base Tool only when RAG is explicitly enabled and SHALL preserve the existing Tool set otherwise.

#### Scenario: RAG is disabled

- **WHEN** the Agent starts without `RAG_ENABLED=true`
- **THEN** it SHALL NOT create a RAG service or expose `query_knowledge_base`

#### Scenario: RAG is enabled without an embedding credential

- **WHEN** `RAG_ENABLED=true` and `SILICONFLOW_API_KEY` is missing
- **THEN** configuration loading SHALL fail with the missing variable name

### Requirement: Agent can retrieve traceable evidence

The Tool SHALL accept a non-empty user query, retrieve up to the requested number of parent documents, and return numbered evidence containing source paths and heading paths.

#### Scenario: Valid knowledge query

- **WHEN** the Agent calls `query_knowledge_base` with a valid query
- **THEN** the Tool SHALL return the retriever evidence, source metadata, latency, and Embedding usage without generating a final answer

#### Scenario: Invalid knowledge query

- **WHEN** the query is empty or `topK` is outside 1 through 5
- **THEN** the Tool SHALL return `input_error` without calling the retriever

### Requirement: RAG resources are closed

The Agent CLI SHALL close an initialized RAG service when the process input loop ends or initialization after RAG setup fails.

#### Scenario: CLI exits

- **WHEN** an enabled Agent CLI finishes its input loop
- **THEN** it SHALL close the RAG database connection pool
