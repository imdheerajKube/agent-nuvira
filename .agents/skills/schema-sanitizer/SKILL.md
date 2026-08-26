---
name: schema-sanitizer
description: Sanitize and validate data schemas: input validation, output sanitization, schema transformation, and type coercion. Use when ensuring data conforms to expected formats and preventing injection attacks.
version: 1.0.0
---

# schema-sanitizer

Sanitize and validate data schemas: input validation, output sanitization, schema transformation, and type coercion. Use when ensuring data conforms to expected formats and preventing injection attacks.

## Goal pattern

schema sanitizer validation input output type coercion injection prevention transformation

## Steps

0. [context-gatherer] Map the data: what input sources (API, form, file)? What formats (JSON, XML, CSV)? What validation rules? What security concerns?

1. [planner] Design the sanitizer:
1. Schema definition: JSON Schema, Zod, or custom validators
2. Input validation: type checking, range validation, format matching
3. Output sanitization: XSS prevention, SQL injection prevention
4. Type coercion: safe type conversion with defaults
5. Error handling: structured error messages
6. Performance: streaming validation for large inputs (after: 'step-0')

2. [runner] Implement the sanitizer:
1. Define validation schemas
2. Implement input validation
3. Add output sanitization
4. Create type coercion layer
5. Test with valid and invalid inputs
6. Benchmark performance (after: 'step-1')

3. [reviewer] Verify: valid inputs pass, invalid inputs rejected, sanitization prevents attacks, performance acceptable. (after: 'step-2')
