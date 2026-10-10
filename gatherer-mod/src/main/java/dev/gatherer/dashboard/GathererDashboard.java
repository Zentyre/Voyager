package dev.gatherer.dashboard;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.minecraft.client.KeyMapping;
import net.minecraft.resources.Identifier;
import com.mojang.blaze3d.platform.InputConstants;

/** Press J (changeable in Controls) to open the Gatherer dashboard in game. */
public class GathererDashboard implements ClientModInitializer {
	public static final String ID = "gatherer_dashboard";

	@Override
	public void onInitializeClient() {
		KeyMapping.Category category = KeyMapping.Category.register(Identifier.fromNamespaceAndPath(ID, "main"));
		KeyMapping open = KeyMappingHelper.registerKeyMapping(new KeyMapping("key." + ID + ".open", InputConstants.KEY_J, category));
		DashboardClient client = new DashboardClient(DashboardConfig.load());

		ClientTickEvents.END_CLIENT_TICK.register(mc -> {
			while (open.consumeClick()) {
				if (mc.gui.screen() == null) mc.setScreenAndShow(new DashboardScreen(client));
			}
		});
	}
}
