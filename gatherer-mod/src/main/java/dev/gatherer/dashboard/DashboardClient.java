package dev.gatherer.dashboard;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;

/**
 * Talks to the Gatherer dashboard: GET /status for the bots and the log,
 * POST /command to send one. All off the game thread.
 */
public class DashboardClient {
	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
	public final DashboardConfig config;

	/** The latest /status (bots, logs), or null before the first one. */
	public volatile JsonObject status;
	/** Why the last /status failed, or null when it worked. */
	public volatile String error;
	public volatile long updatedAt;
	private volatile boolean polling;
	private long polledAt;

	public DashboardClient(DashboardConfig config) {
		this.config = config;
	}

	private HttpRequest.Builder request(String path) {
		return HttpRequest.newBuilder(URI.create(config.url() + path)).timeout(Duration.ofSeconds(5));
	}

	/** Ask for the status again, if it's been a second and nothing's on its way. */
	public void poll() {
		long now = System.currentTimeMillis();
		if (polling || now - polledAt < 1000) return;
		polling = true;
		polledAt = now;
		HttpRequest req = request("/status?logs=60").GET().build();
		http.sendAsync(req, HttpResponse.BodyHandlers.ofString()).whenComplete((res, err) -> {
			try {
				if (err != null) {
					error = "Can't reach Gatherer's dashboard on port " + config.port + " (is Gatherer running?)";
				} else if (res.statusCode() != 200) {
					error = "The dashboard said " + res.statusCode() + " (an old Gatherer? Update it)";
				} else {
					status = JsonParser.parseString(res.body()).getAsJsonObject();
					updatedAt = System.currentTimeMillis();
					error = null;
				}
			} catch (Exception e) {
				error = "Unexpected answer from the dashboard: " + e.getMessage();
			} finally {
				polling = false;
			}
		});
	}

	/** Poll again straight away (after sending a command). */
	public void soon() {
		polledAt = 0;
	}

	/** Send a command to one bot (its label) or "auto" (the crew decides). Completes with null, or what went wrong. */
	public CompletableFuture<String> send(String target, String text) {
		JsonObject body = new JsonObject();
		body.addProperty("target", target);
		body.addProperty("text", text);
		try {
			HttpRequest req = request("/command").header("content-type", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
			return http.sendAsync(req, HttpResponse.BodyHandlers.ofString()).handle((res, err) -> {
				soon();
				if (err != null) return "Couldn't send it: can't reach the dashboard";
				if (res.statusCode() != 200) return "Couldn't send it (" + res.statusCode() + ")";
				return null;
			});
		} catch (Exception e) {
			return CompletableFuture.completedFuture("Couldn't send it: " + e.getMessage());
		}
	}

	public JsonArray bots() {
		JsonObject s = status;
		return s != null && s.has("bots") && s.get("bots").isJsonArray() ? s.getAsJsonArray("bots") : new JsonArray();
	}

	public JsonArray logs() {
		JsonObject s = status;
		return s != null && s.has("logs") && s.get("logs").isJsonArray() ? s.getAsJsonArray("logs") : new JsonArray();
	}
}
