package dev.gatherer.dashboard;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class GathererLog {
	private static final Logger LOG = LoggerFactory.getLogger("Gatherer Dashboard");

	static void warn(String message) {
		LOG.warn(message);
	}
}
