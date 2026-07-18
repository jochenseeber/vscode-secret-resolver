import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import sun.misc.Signal;

public final class TestJavaLaunch1 {
    private TestJavaLaunch1() {}

    public static void main(String[] args) throws InterruptedException {
        installSignalLoggers();
        System.getenv().entrySet().stream()
            .filter(TestJavaLaunch1::shouldPrint)
            .sorted(Map.Entry.comparingByKey())
            .forEach(entry -> System.out.println(entry.getKey() + "=" + entry.getValue()));
        Thread.sleep(300_000);
    }

    private static void installSignalLoggers() {
        AtomicInteger count = new AtomicInteger(0);

        for (String name : new String[] { "TERM", "INT", "HUP" }) {
            try {
                Signal.handle(new Signal(name), sig -> {
                    int n = count.incrementAndGet();
                    System.out.println("[TestJavaLaunch] Received SIG" + sig.getName() + " (" + n + "/3)");
                    System.out.flush();

                    if (n >= 3) {
                        System.out.println("[TestJavaLaunch] Received 3 signals, exiting.");
                        System.exit(0);
                    }
                });
            }
            catch (IllegalArgumentException ex) {
                // Signal not supported on this platform; skip.
            }
        }
    }

    private static boolean shouldPrint(Map.Entry<String, String> entry) {
        String key = entry.getKey();
        return key.startsWith("TEST_") || key.startsWith("OP_");
    }
}
