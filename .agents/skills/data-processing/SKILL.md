---
name: data-processing
description: Process and transform data using Pandas, NumPy, or Polars. Use when the goal asks to clean, transform, aggregate, or analyze datasets.
version: 2.0.0
whenToUse: Data cleaning, transformation, ETL pipelines, aggregation, CSV/JSON processing, data validation
whenNotToUse: Real-time stream processing (use kafka-queue), ML model training (use ml-model), simple file reading
---

# Data Processing

Process and transform data with production patterns.

## Goal pattern

data processing pandas numpy polars CSV JSON transform clean aggregate ETL

## Parameters

- framework (choice [default: pandas]): Processing framework
- output (choice [default: csv]): Output format
- validation (boolean [default: true]): Validate data quality

## Steps

### Step 1: [context-gatherer] — Analyze data requirements

```bash
# Check data files
ls -la data/
head -5 data/*.csv 2>/dev/null
wc -l data/*.csv 2>/dev/null

# Check Python environment
python3 -c "import pandas; print(pandas.__version__)"
python3 -c "import polars; print(polars.__version__)" 2>/dev/null

# Check data size
du -sh data/*
```

- What data format? (CSV, JSON, Parquet, database)
- What transformations? (clean, aggregate, join, pivot)
- What output format? (CSV, JSON, database)
- What data quality? (missing values, duplicates, outliers)

### Step 2: [writer] — Create processing pipeline

```python
# src/processing/pipeline.py
import pandas as pd
import numpy as np
from pathlib import Path
import logging

logger = logging.getLogger(__name__)

def load_data(path: str) -> pd.DataFrame:
    """Load data with error handling."""
    path = Path(path)
    
    if path.suffix == '.csv':
        df = pd.read_csv(path, parse_dates=True)
    elif path.suffix == '.json':
        df = pd.read_json(path)
    elif path.suffix == '.parquet':
        df = pd.read_parquet(path)
    else:
        raise ValueError(f"Unsupported format: {path.suffix}")
    
    logger.info(f"Loaded {len(df)} rows, {len(df.columns)} columns")
    return df

def clean_data(df: pd.DataFrame) -> pd.DataFrame:
    """Clean and validate data."""
    initial_rows = len(df)
    
    # Remove duplicates
    df = df.drop_duplicates()
    logger.info(f"Removed {initial_rows - len(df)} duplicate rows")
    
    # Handle missing values
    numeric_cols = df.select_dtypes(include=[np.number]).columns
    categorical_cols = df.select_dtypes(include=['object']).columns
    
    df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())
    df[categorical_cols] = df[categorical_cols].fillna('Unknown')
    
    # Remove outliers (IQR method)
    for col in numeric_cols:
        Q1 = df[col].quantile(0.25)
        Q3 = df[col].quantile(0.75)
        IQR = Q3 - Q1
        df = df[(df[col] >= Q1 - 1.5 * IQR) & (df[col] <= Q3 + 1.5 * IQR)]
    
    logger.info(f"Cleaned data: {len(df)} rows remaining")
    return df

def transform_data(df: pd.DataFrame) -> pd.DataFrame:
    """Apply transformations."""
    # Feature engineering
    if 'date' in df.columns:
        df['date'] = pd.to_datetime(df['date'])
        df['year'] = df['date'].dt.year
        df['month'] = df['date'].dt.month
        df['day_of_week'] = df['date'].dt.dayofweek
    
    # Aggregation
    if 'category' in df.columns and 'value' in df.columns:
        agg_df = df.groupby('category').agg({
            'value': ['mean', 'std', 'min', 'max', 'count']
        }).reset_index()
        agg_df.columns = ['category', 'value_mean', 'value_std', 'value_min', 'value_max', 'count']
    
    return df

def validate_data(df: pd.DataFrame) -> bool:
    """Validate data quality."""
    checks = []
    
    # Check for nulls
    null_count = df.isnull().sum().sum()
    checks.append(f"Null values: {null_count}")
    
    # Check for duplicates
    dup_count = df.duplicated().sum()
    checks.append(f"Duplicate rows: {dup_count}")
    
    # Check data types
    for col in df.columns:
        if df[col].dtype == 'object':
            avg_length = df[col].str.len().mean()
            checks.append(f"{col}: avg length {avg_length:.1f}")
    
    logger.info("Data validation: " + " | ".join(checks))
    return null_count == 0 and dup_count == 0

def save_data(df: pd.DataFrame, path: str):
    """Save processed data."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    
    if path.suffix == '.csv':
        df.to_csv(path, index=False)
    elif path.suffix == '.json':
        df.to_json(path, orient='records', indent=2)
    elif path.suffix == '.parquet':
        df.to_parquet(path, index=False)
    
    logger.info(f"Saved {len(df)} rows to {path}")

# Main pipeline
def run_pipeline(input_path: str, output_path: str):
    """Execute the full processing pipeline."""
    df = load_data(input_path)
    df = clean_data(df)
    df = transform_data(df)
    validate_data(df)
    save_data(df, output_path)
    return df
```

### Step 3: [runner] — Execute pipeline

```bash
# Run processing pipeline
python -m src.processing.pipeline \
  --input data/raw/sales.csv \
  --output data/processed/sales_clean.csv

# Verify output
head -5 data/processed/sales_clean.csv
wc -l data/processed/sales_clean.csv

# Check data quality
python -c "
import pandas as pd
df = pd.read_csv('data/processed/sales_clean.csv')
print(f'Rows: {len(df)}')
print(f'Columns: {list(df.columns)}')
print(f'Nulls: {df.isnull().sum().sum()}')
print(f'Duplicates: {df.duplicated().sum()}')
"
```

### Step 4: [reviewer] — Verify data quality

```bash
# Check output file
ls -la data/processed/

# Verify data integrity
python -c "
import pandas as pd
df = pd.read_csv('data/processed/sales_clean.csv')
print(df.describe())
print(df.head())
"

# Compare input/output
python -c "
import pandas as pd
original = pd.read_csv('data/raw/sales.csv')
processed = pd.read_csv('data/processed/sales_clean.csv')
print(f'Original: {len(original)} rows')
print(f'Processed: {len(processed)} rows')
print(f'Rows removed: {len(original) - len(processed)}')
"
```

**Verification checklist:**
- [ ] No null values in output
- [ ] No duplicate rows
- [ ] Data types correct
- [ ] Outliers handled
- [ ] Transformations applied correctly
- [ ] Output format valid
- [ ] Processing time acceptable

## Reference Documents

Load deep-dive content with `skill_view('data-processing', 'references/guide.md')`.
