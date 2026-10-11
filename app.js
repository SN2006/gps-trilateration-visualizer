(() => {
  "use strict";

  const WS_URL = "ws://localhost:21701";
  const AREA_SIZE_KM = 100;
  const DEFAULT_SPREAD_MS = 1000;
  const MAX_MEASURE_AGE_MS = 5000;
  const TRAIL_DURATION_MS = 30000;
  const EPSILON = 1e-10;

  const satellites = new Map();
  const state = {
    socket: null,
    numericalPosition: null,
    analyticalPosition: null,
    lastLoss: null,
    lastValidReceivedAt: null,
    reconnectTimer: null,
    analyticalTrail: [],
    numericalTrail: [],
    statisticsStartedAt: null,
    analyticalSamplesCount: 0,
    numericalSamplesCount: 0,
    lastAnalyticalSample: null,
    lastNumericalSample: null,
    analyticalStepSum: 0,
    numericalStepSum: 0,
    analyticalMaximumStep: 0,
    numericalMaximumStep: 0
  };

  const elements = {
    canvas: document.querySelector("#plot"),
    connectionStatus: document.querySelector("#connectionStatus"),
    spreadInput: document.querySelector("#spreadInput"),
    reconnectButton: document.querySelector("#reconnectButton"),
    chartMessage: document.querySelector("#chartMessage"),
    satelliteCount: document.querySelector("#satelliteCount"),
    spreadValue: document.querySelector("#spreadValue"),
    updatedValue: document.querySelector("#updatedValue"),
    lossValue: document.querySelector("#lossValue"),
    analyticalPosition: document.querySelector("#analyticalPosition"),
    numericalPosition: document.querySelector("#numericalPosition"),
    analyticalSamples: document.querySelector("#analyticalSamples"),
    numericalSamples: document.querySelector("#numericalSamples"),
    analyticalAverageStep: document.querySelector("#analyticalAverageStep"),
    numericalAverageStep: document.querySelector("#numericalAverageStep"),
    analyticalMaximumStep: document.querySelector("#analyticalMaximumStep"),
    numericalMaximumStep: document.querySelector("#numericalMaximumStep"),
    statisticsPeriod: document.querySelector("#statisticsPeriod"),
    message: document.querySelector("#message")
  };

  const context = elements.canvas.getContext("2d");

  function getSpreadLimit() {
    const value = Number(elements.spreadInput.value);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SPREAD_MS;
  }

  function setStatus(text, className) {
    elements.connectionStatus.textContent = text;
    elements.connectionStatus.className = `status status--${className}`;
  }

  function setMessage(text) {
    elements.message.textContent = text;
    elements.chartMessage.textContent = text;
  }

  function formatPosition(position) {
    return position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? `x = ${position.x.toFixed(3)} км, y = ${position.y.toFixed(3)} км`
      : "Немає даних";
  }

  function isValidMeasurement(value) {
    return value
      && typeof value.id === "string"
      && Number.isFinite(Number(value.x))
      && Number.isFinite(Number(value.y))
      && Number.isFinite(Number(value.sentAt))
      && Number.isFinite(Number(value.receivedAt))
      && Number(value.receivedAt) >= Number(value.sentAt);
  }

  function toMeasurement(value) {
    const sentAt = Number(value.sentAt);
    const receivedAt = Number(value.receivedAt);
    return {
      id: value.id,
      x: Number(value.x),
      y: Number(value.y),
      sentAt,
      receivedAt,
      distance: 300 * (receivedAt - sentAt)
    };
  }

  function removeOldSatellites(referenceTime) {
    for (const [id, measurement] of satellites) {
      if (referenceTime - measurement.receivedAt > MAX_MEASURE_AGE_MS) {
        satellites.delete(id);
      }
    }
  }

  function getCurrentMeasurements() {
    const values = Array.from(satellites.values())
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, 3);
    return values.length === 3 ? values : null;
  }

  function calculateAnalytical(measurements) {
    const [first, second, third] = measurements;
    const a = 2 * (second.x - first.x);
    const b = 2 * (second.y - first.y);
    const c = first.distance ** 2 - second.distance ** 2
      - first.x ** 2 + second.x ** 2 - first.y ** 2 + second.y ** 2;
    const d = 2 * (third.x - second.x);
    const e = 2 * (third.y - second.y);
    const f = second.distance ** 2 - third.distance ** 2
      - second.x ** 2 + third.x ** 2 - second.y ** 2 + third.y ** 2;
    const denominator = e * a - b * d;

    if (!Number.isFinite(denominator) || Math.abs(denominator) < EPSILON) {
      return null;
    }

    const x = (c * e - f * b) / denominator;
    const y = (c * d - a * f) / (b * d - a * e);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function lossAt(x, y, measurements) {
    return measurements.reduce((total, measurement) => {
      const calculatedDistance = Math.hypot(x - measurement.x, y - measurement.y);
      const error = calculatedDistance - measurement.distance;
      return total + error * error;
    }, 0);
  }

  function gradientAt(x, y, measurements) {
    let gradientX = 0;
    let gradientY = 0;

    for (const measurement of measurements) {
      const deltaX = x - measurement.x;
      const deltaY = y - measurement.y;
      const calculatedDistance = Math.hypot(deltaX, deltaY);
      if (calculatedDistance < EPSILON) {
        continue;
      }
      const error = calculatedDistance - measurement.distance;
      gradientX += 2 * error * deltaX / calculatedDistance;
      gradientY += 2 * error * deltaY / calculatedDistance;
    }
    return { x: gradientX, y: gradientY };
  }

  function calculateNumerical(measurements, initialPosition) {
    let position = initialPosition && Number.isFinite(initialPosition.x)
      && Number.isFinite(initialPosition.y)
      ? { ...initialPosition }
      : { x: 50, y: 50 };
    let currentLoss = lossAt(position.x, position.y, measurements);
    let step = 0.08;

    for (let iteration = 0; iteration < 800; iteration += 1) {
      const gradient = gradientAt(position.x, position.y, measurements);
      const gradientLength = Math.hypot(gradient.x, gradient.y);
      if (gradientLength < 1e-7) {
        break;
      }

      const candidate = {
        x: position.x - step * gradient.x,
        y: position.y - step * gradient.y
      };
      const candidateLoss = lossAt(candidate.x, candidate.y, measurements);

      if (candidateLoss < currentLoss) {
        position = candidate;
        if (Math.abs(currentLoss - candidateLoss) < 1e-10) {
          currentLoss = candidateLoss;
          break;
        }
        currentLoss = candidateLoss;
        step = Math.min(step * 1.03, 1);
      } else {
        step *= 0.5;
        if (step < 1e-8) {
          break;
        }
      }
    }

    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return null;
    }
    return { position, loss: currentLoss };
  }

  function drawPoint(x, y, color, label, radius = 7) {
    const padding = 54;
    const width = elements.canvas.width - padding * 2;
    const height = elements.canvas.height - padding * 2;
    const canvasX = padding + (x / AREA_SIZE_KM) * width;
    const canvasY = elements.canvas.height - padding - (y / AREA_SIZE_KM) * height;

    context.beginPath();
    context.arc(canvasX, canvasY, radius, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#f4f8ff";
    context.stroke();
    context.fillStyle = "#e8eef8";
    context.font = "13px Segoe UI, sans-serif";
    context.fillText(label, canvasX + 10, canvasY - 10);
  }

  function canvasCoordinates(x, y) {
    const padding = 54;
    const width = elements.canvas.width - padding * 2;
    const height = elements.canvas.height - padding * 2;
    return {
      x: padding + (x / AREA_SIZE_KM) * width,
      y: elements.canvas.height - padding - (y / AREA_SIZE_KM) * height
    };
  }

  function drawTrail(trail, color, now) {
    if (trail.length === 0) {
      return;
    }

    for (let index = 0; index < trail.length; index += 1) {
      const sample = trail[index];
      const age = now - sample.timestamp;
      const opacity = Math.max(0, 1 - age / TRAIL_DURATION_MS);
      if (opacity <= 0) {
        continue;
      }
      const point = canvasCoordinates(sample.position.x, sample.position.y);
      context.beginPath();
      context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      context.fillStyle = color.replace("ALPHA", opacity.toFixed(3));
      context.fill();
      if (index > 0) {
        const previous = trail[index - 1];
        const previousAge = now - previous.timestamp;
        const previousOpacity = Math.max(0, 1 - previousAge / TRAIL_DURATION_MS);
        const previousPoint = canvasCoordinates(previous.position.x, previous.position.y);
        context.beginPath();
        context.moveTo(previousPoint.x, previousPoint.y);
        context.lineTo(point.x, point.y);
        context.strokeStyle = color.replace("ALPHA", Math.min(opacity, previousOpacity).toFixed(3));
        context.lineWidth = 1.5;
        context.stroke();
      }
    }
  }

  function drawChart(measurements, analyticalPosition, numericalPosition) {
    const width = elements.canvas.width;
    const height = elements.canvas.height;
    const padding = 54;
    const plotWidth = width - padding * 2;
    const plotHeight = height - padding * 2;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#111b2c";
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "#263a57";
    context.lineWidth = 1;
    context.fillStyle = "#8d9bb2";
    context.font = "12px Segoe UI, sans-serif";

    for (let tick = 0; tick <= AREA_SIZE_KM; tick += 10) {
      const x = padding + (tick / AREA_SIZE_KM) * plotWidth;
      const y = height - padding - (tick / AREA_SIZE_KM) * plotHeight;
      context.beginPath();
      context.moveTo(x, padding);
      context.lineTo(x, height - padding);
      context.stroke();
      context.beginPath();
      context.moveTo(padding, y);
      context.lineTo(width - padding, y);
      context.stroke();
      context.fillText(String(tick), x - (tick === 100 ? 8 : 4), height - padding + 21);
      context.fillText(String(tick), padding - 28, y + 4);
    }

    context.strokeStyle = "#a6b6cd";
    context.lineWidth = 2;
    context.strokeRect(padding, padding, plotWidth, plotHeight);
    context.fillStyle = "#b6c4d8";
    context.fillText("x, км", width - padding - 30, height - 13);
    context.fillText("y, км", 14, padding - 12);

    if (!measurements) {
      context.fillStyle = "#9eacc2";
      context.font = "16px Segoe UI, sans-serif";
      context.fillText("Очікування трьох актуальних супутників", padding + 40, height / 2);
      return;
    }

    const now = Date.now();
    state.analyticalTrail = state.analyticalTrail.filter((sample) => now - sample.timestamp <= TRAIL_DURATION_MS);
    state.numericalTrail = state.numericalTrail.filter((sample) => now - sample.timestamp <= TRAIL_DURATION_MS);
    drawTrail(state.analyticalTrail, "rgba(255, 107, 129, ALPHA)", now);
    drawTrail(state.numericalTrail, "rgba(101, 214, 155, ALPHA)", now);
    measurements.forEach((measurement, index) => {
      drawPoint(measurement.x, measurement.y, "#61dafb", `S${index + 1}`, 8);
    });
    if (analyticalPosition) {
      drawPoint(analyticalPosition.x, analyticalPosition.y, "#ff6b81", "A", 7);
    }
    if (numericalPosition) {
      drawPoint(numericalPosition.x, numericalPosition.y, "#65d69b", "N", 7);
    }
  }

  function updateView(measurements, spread) {
    elements.satelliteCount.textContent = `${satellites.size} / 3`;
    elements.spreadValue.textContent = spread === null ? "Немає даних" : `${spread.toFixed(2)} мс`;
    elements.updatedValue.textContent = state.lastValidReceivedAt
      ? new Date(state.lastValidReceivedAt).toLocaleTimeString("uk-UA")
      : "Немає даних";
    elements.analyticalPosition.textContent = formatPosition(state.analyticalPosition);
    elements.numericalPosition.textContent = formatPosition(state.numericalPosition);
    elements.lossValue.textContent = state.lastLoss === null ? "Немає даних" : state.lastLoss.toFixed(6);
    updateStatisticsView();
    drawChart(measurements, state.analyticalPosition, state.numericalPosition);
  }

  function distanceBetween(first, second) {
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : null;
  }

  function addPositionSample(method, position) {
    if (!position) {
      return;
    }
    const trail = method === "analytical" ? state.analyticalTrail : state.numericalTrail;
    const previous = method === "analytical"
      ? state.lastAnalyticalSample
      : state.lastNumericalSample;
    const step = distanceBetween(previous, position);
    if (state.statisticsStartedAt === null) {
      state.statisticsStartedAt = Date.now();
    }
    if (method === "analytical") {
      state.analyticalSamplesCount += 1;
    } else {
      state.numericalSamplesCount += 1;
    }
    if (step !== null) {
      if (method === "analytical") {
        state.analyticalStepSum += step;
        state.analyticalMaximumStep = Math.max(state.analyticalMaximumStep, step);
      } else {
        state.numericalStepSum += step;
        state.numericalMaximumStep = Math.max(state.numericalMaximumStep, step);
      }
    }
    trail.push({ position: { ...position }, timestamp: Date.now() });
    if (method === "analytical") {
      state.lastAnalyticalSample = { ...position };
    } else {
      state.lastNumericalSample = { ...position };
    }
  }

  function formatStep(value) {
    return value === 0 ? "0,000 км" : `${value.toFixed(3)} км`;
  }

  function updateStatisticsView() {
    const analyticalCount = state.analyticalSamplesCount;
    const numericalCount = state.numericalSamplesCount;
    const analyticalTransitions = Math.max(0, analyticalCount - 1);
    const numericalTransitions = Math.max(0, numericalCount - 1);
    elements.analyticalSamples.textContent = String(analyticalCount);
    elements.numericalSamples.textContent = String(numericalCount);
    elements.analyticalAverageStep.textContent = analyticalTransitions
      ? formatStep(state.analyticalStepSum / analyticalTransitions)
      : "Немає даних";
    elements.numericalAverageStep.textContent = numericalTransitions
      ? formatStep(state.numericalStepSum / numericalTransitions)
      : "Немає даних";
    elements.analyticalMaximumStep.textContent = analyticalCount > 1
      ? formatStep(state.analyticalMaximumStep)
      : "Немає даних";
    elements.numericalMaximumStep.textContent = numericalCount > 1
      ? formatStep(state.numericalMaximumStep)
      : "Немає даних";
    elements.statisticsPeriod.textContent = state.statisticsStartedAt
      ? `Період спостереження: ${((Date.now() - state.statisticsStartedAt) / 1000).toFixed(0)} с`
      : "Період спостереження: немає даних";
  }

  function processMeasurement(rawValue) {
    if (!isValidMeasurement(rawValue)) {
      setMessage("Отримано повідомлення з некоректними полями. Воно пропущене.");
      return;
    }

    const measurement = toMeasurement(rawValue);
    satellites.set(measurement.id, measurement);
    removeOldSatellites(measurement.receivedAt);

    const measurements = getCurrentMeasurements();
    if (!measurements) {
      updateView(null, null);
      setMessage("Очікування даних від трьох різних супутників.");
      return;
    }

    const receivedTimes = measurements.map((item) => item.receivedAt);
    const spread = Math.max(...receivedTimes) - Math.min(...receivedTimes);
    updateView(measurements, spread);

    if (spread > getSpreadLimit()) {
      setMessage(`Розрахунок призупинено: розкид receivedAt ${spread.toFixed(2)} мс перевищує встановлений поріг.`);
      return;
    }

    const analyticalPosition = calculateAnalytical(measurements);
    const numericalStart = analyticalPosition || state.numericalPosition;
    const numericalResult = calculateNumerical(measurements, numericalStart);
    state.analyticalPosition = analyticalPosition;
    state.numericalPosition = numericalResult ? numericalResult.position : null;
    state.lastLoss = numericalResult ? numericalResult.loss : null;
    state.lastValidReceivedAt = Date.now();
    addPositionSample("analytical", analyticalPosition);
    addPositionSample("numerical", state.numericalPosition);
    updateView(measurements, spread);

    if (!analyticalPosition && !numericalResult) {
      setMessage("Не вдалося отримати жодного коректного розв’язку для поточного набору вимірювань.");
    } else if (!analyticalPosition) {
      setMessage("Аналітичний метод нестійкий для поточного розташування супутників. Чисельний результат доступний.");
    } else {
      setMessage("Розрахунок виконано. Червона точка показує аналітичний метод, зелена точка показує чисельний метод.");
    }
  }

  function connect() {
    if (state.socket) {
      state.socket.close();
    }
    setStatus("Підключення...", "connecting");
    setMessage("Встановлення з’єднання з GPS-емулятором.");

    try {
      const socket = new WebSocket(WS_URL);
      state.socket = socket;
      socket.addEventListener("open", () => {
        setStatus("Підключено", "online");
        setMessage("З’єднання з GPS-емулятором встановлено.");
      });
      socket.addEventListener("message", (event) => {
        try {
          processMeasurement(JSON.parse(event.data));
        } catch {
          setMessage("Не вдалося розібрати повідомлення від емулятора.");
        }
      });
      socket.addEventListener("error", () => {
        setStatus("Помилка з’єднання", "offline");
        setMessage("Не вдалося отримати дані. Перевірте, чи запущено Docker-емулятор.");
      });
      socket.addEventListener("close", () => {
        setStatus("Не підключено", "offline");
        if (state.reconnectTimer) {
          clearTimeout(state.reconnectTimer);
        }
        state.reconnectTimer = setTimeout(connect, 3000);
      });
    } catch {
      setStatus("Помилка з’єднання", "offline");
      setMessage("Браузер не зміг створити WebSocket-підключення.");
    }
  }

  elements.reconnectButton.addEventListener("click", connect);
  elements.spreadInput.addEventListener("change", () => {
    const measurements = getCurrentMeasurements();
    if (measurements) {
      const times = measurements.map((item) => item.receivedAt);
      updateView(measurements, Math.max(...times) - Math.min(...times));
    }
  });

  drawChart(null, null, null);
  elements.spreadInput.value = DEFAULT_SPREAD_MS;
  connect();
})();
