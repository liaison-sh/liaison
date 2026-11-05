package sh.liaison.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's local plugins, which no package names, before the bridge starts.
        registerPlugin(LiaisonAuthSessionPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
