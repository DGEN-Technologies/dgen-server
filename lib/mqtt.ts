import mqtt from "mqtt";
import { getConfig } from "./config-loader";

export default mqtt.connect("mqtt://mqtt.dgentech.io", getConfig().mqtt);
