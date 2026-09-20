"""MyComfyUIの音声とASRのBackendを束ねるrunner。

TTSとASRの本体はこのパッケージへimportしない。engineごとの別venvのPythonを
subprocessで起動し、1リクエストにつき1つのBackendだけをロードする。
"""
