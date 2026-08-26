---
name: time-series
description: Analyze and forecast time series data: decomposition, stationarity testing, ARIMA, Prophet, and LSTM models. Use when the goal is to understand or predict temporal patterns.
version: 1.0.0
---

# time-series

Analyze and forecast time series data: decomposition, stationarity testing, ARIMA, Prophet, and LSTM models. Use when the goal is to understand or predict temporal patterns.

## Goal pattern

time series forecasting ARIMA prophet LSTM decomposition stationarity trend seasonality prediction

## Steps

0. [context-gatherer] Map the data: time granularity (hourly, daily, weekly)? Historical range? Seasonality patterns? External regressors? Forecast horizon?

1. [planner] Plan the analysis:
1. Exploration: plot the series, check for trend/seasonality/outliers
2. Stationarity: ADF test, KPSS test, differencing
3. Models: ARIMA/SARIMA (statistical), Prophet (robust), LSTM (complex patterns)
4. Validation: time series split (no random shuffle), MAE/RMSE/MAPE
5. Deployment: save model, create prediction pipeline (after: 'step-0')

2. [runner] Implement the analysis:
1. Load and visualize the time series
2. Test for stationarity
3. Fit ARIMA/Prophet model
4. Validate with time series cross-validation
5. Generate forecast with confidence intervals
6. Save model and prediction function (after: 'step-1')

3. [reviewer] Verify: plot forecast vs actual, check residuals (should be white noise), verify confidence intervals, test on hold-out period. (after: 'step-2')
