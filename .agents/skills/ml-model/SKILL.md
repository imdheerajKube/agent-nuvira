---
name: ml-model
description: Build and train ML models using scikit-learn, TensorFlow, or PyTorch. Use when the goal asks to train, evaluate, or deploy machine learning models.
version: 2.0.0
whenToUse: Model training, feature engineering, model evaluation, prediction pipelines, A/B testing models
whenNotToUse: Simple data analysis (use pandas), rule-based systems, LLM prompt engineering
---

# ML Model

Build and train ML models with production patterns.

## Goal pattern

machine learning model training evaluation prediction scikit-learn tensorflow pytorch classification regression

## Parameters

- framework (choice [default: scikit-learn]): ML framework
- task (choice [default: classification]): ML task type
- deployment (choice [default: api]): Model serving method

## Steps

### Step 1: [analyst] — Analyze data and requirements

```bash
# Check available data
ls data/
wc -l data/*.csv 2>/dev/null

# Check Python ML environment
python3 -c "import sklearn; print(sklearn.__version__)"
python3 -c "import pandas; print(pandas.__version__)"
pip list | grep -E "scikit|tensorflow|torch|xgboost"

# Check GPU availability
nvidia-smi 2>/dev/null || echo "No GPU"
```

- What data format? (CSV, Parquet, database)
- What task? (classification, regression, clustering)
- What metrics matter? (accuracy, F1, RMSE, AUC)
- What constraints? (latency, memory, explainability)

### Step 2: [analyst] — Build training pipeline

```python
# src/models/train.py
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
import joblib
import json
from pathlib import Path

def load_data(path: str) -> pd.DataFrame:
    """Load and validate data."""
    df = pd.read_csv(path)
    print(f"Loaded {len(df)} rows, {len(df.columns)} columns")
    print(f"Missing values:\n{df.isnull().sum()}")
    return df

def preprocess(df: pd.DataFrame) -> tuple:
    """Feature engineering and preprocessing."""
    # Handle missing values
    df = df.fillna(df.median(numeric_only=True))
    
    # Encode categoricals
    le = LabelEncoder()
    for col in df.select_dtypes(include='object').columns:
        df[col] = le.fit_transform(df[col])
    
    # Feature engineering
    if 'timestamp' in df.columns:
        df['hour'] = pd.to_datetime(df['timestamp']).dt.hour
        df['day_of_week'] = pd.to_datetime(df['timestamp']).dt.dayofweek
    
    X = df.drop('target', axis=1)
    y = df['target']
    
    return X, y

def train_model(X, y) -> tuple:
    """Train with cross-validation."""
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)
    
    model = RandomForestClassifier(
        n_estimators=100,
        max_depth=10,
        min_samples_split=5,
        random_state=42,
        n_jobs=-1
    )
    
    # Cross-validation
    cv_scores = cross_val_score(model, X_train_scaled, y_train, cv=5)
    print(f"CV Accuracy: {cv_scores.mean():.4f} (+/- {cv_scores.std():.4f})")
    
    # Train final model
    model.fit(X_train_scaled, y_train)
    
    # Evaluate
    y_pred = model.predict(X_test_scaled)
    print(classification_report(y_test, y_pred))
    
    return model, scaler, {
        'cv_accuracy': cv_scores.mean(),
        'cv_std': cv_scores.std(),
        'test_report': classification_report(y_test, y_pred, output_dict=True)
    }

def save_model(model, scaler, metrics, output_dir='models/'):
    """Save model artifacts."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    
    joblib.dump(model, f'{output_dir}/model.joblib')
    joblib.dump(scaler, f'{output_dir}/scaler.joblib')
    
    with open(f'{output_dir}/metrics.json', 'w') as f:
        json.dump(metrics, f, indent=2)
    
    print(f"Model saved to {output_dir}")

if __name__ == '__main__':
    df = load_data('data/training.csv')
    X, y = preprocess(df)
    model, scaler, metrics = train_model(X, y)
    save_model(model, scaler, metrics)
```

### Step 3: [analyst] — Train and evaluate

```bash
# Train model
python src/models/train.py

# Evaluate on test set
python -c "
import joblib
import json
from sklearn.metrics import accuracy_score
import pandas as pd

model = joblib.load('models/model.joblib')
scaler = joblib.load('models/scaler.joblib')

df = pd.read_csv('data/test.csv')
X = df.drop('target', axis=1)
y = df['target']

X_scaled = scaler.transform(X)
y_pred = model.predict(X_scaled)
print(f'Test Accuracy: {accuracy_score(y, y_pred):.4f}')
"

# Serve model as API
cat > src/models/serve.py << 'EOF'
from fastapi import FastAPI
import joblib
import numpy as np

app = FastAPI()
model = joblib.load('models/model.joblib')
scaler = joblib.load('models/scaler.joblib')

@app.post('/predict')
def predict(features: list[float]):
    X = np.array(features).reshape(1, -1)
    X_scaled = scaler.transform(X)
    prediction = model.predict(X_scaled)
    probability = model.predict_proba(X_scaled)
    return {
        'prediction': int(prediction[0]),
        'confidence': float(max(probability[0]))
    }
EOF

uvicorn src.models.serve:app --host 0.0.0.0 --port 8000
```

### Step 4: [analyst] — Verify model quality

```bash
# Check model metrics
cat models/metrics.json

# Verify prediction works
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"features": [1.0, 2.0, 3.0, 4.0]}'

# Check model file size
ls -lh models/

# Verify no data leakage
python -c "
import joblib
model = joblib.load('models/model.joblib')
print(f'Feature importances: {model.feature_importances_}')
print(f'Number of trees: {model.n_estimators}')
"
```

**Verification checklist:**
- [ ] CV accuracy meets threshold (>80% for classification)
- [ ] No overfitting (CV std < 5%)
- [ ] Test accuracy close to CV accuracy
- [ ] Model file saved and loadable
- [ ] Prediction API returns valid responses
- [ ] Feature importances make sense
- [ ] No data leakage (test set not used in training)

## Reference Documents

Load deep-dive content with `skill_view('ml-model', 'references/model-training.md')`.
