import asyncio
import unittest

from mycomfyui_api.adapters.comfyui import prepare as comfyui_prepare
from mycomfyui_api.adapters.comfyui import workflow as workflow_module
from mycomfyui_api.bootstrap import DEFAULT_INPUT_SCHEMA, DEFAULT_VALUES
from mycomfyui_api.execution import PreparationContext, PreparationError
from mycomfyui_api.models import Recipe

TEMPLATE = "anima_txt2img"
BASE_VALUES = {
    "positive_prompt": "1girl",
    "unet_name": "chosenMixAnima_v10.safetensors",
    "clip_name": "qwen_3_06b_base.safetensors",
    "vae_name": "qwen_image_vae.safetensors",
    "width": 832,
    "height": 1216,
    "steps": 30,
    "seed": 123,
}
HIRES_VALUES = {
    "hires_scale": 2.0,
    "hires_upscale_method": "bislerp",
    "hires_steps": 12,
    "hires_denoise": 0.4,
}

#: Issue #318より前のtxt2imgのノード構成。hires fixオフではこれと同じになる。
LEGACY_GRAPH = {
    "3": {
        "model": ["60", 0],
        "positive": ["6", 0],
        "negative": ["7", 0],
        "latent_image": ["5", 0],
    },
    "5": {},
    "6": {"clip": ["61", 0]},
    "7": {"clip": ["61", 0]},
    "8": {"samples": ["3", 0], "vae": ["62", 0]},
    "9": {"images": ["8", 0]},
    "60": {},
    "61": {},
    "62": {},
}


def _links(workflow: dict) -> dict[str, dict[str, list]]:
    return {
        node_id: {
            key: value
            for key, value in entry["inputs"].items()
            if isinstance(value, list)
        }
        for node_id, entry in workflow.items()
    }


def _recipe() -> Recipe:
    return Recipe(
        id="recipe-test",
        name="test",
        kind="image",
        engine="comfyui",
        workflow_template_ref={"name": TEMPLATE},
        input_schema=dict(DEFAULT_INPUT_SCHEMA),
        defaults=dict(DEFAULT_VALUES),
    )


def _prepare(inputs: dict) -> object:
    context = PreparationContext(
        project_id=None, scene_id=None, shot_id=None, scene_data={}, shot_data={}
    )
    return asyncio.run(comfyui_prepare.prepare(_recipe(), inputs, context))


class BuildWorkflowHiresTest(unittest.TestCase):
    def test_off_keeps_legacy_graph(self) -> None:
        prepared = workflow_module.build_workflow(
            TEMPLATE,
            BASE_VALUES,
            drop_roles=comfyui_prepare.HIRES_ROLES,
        )
        self.assertEqual(_links(prepared.workflow), LEGACY_GRAPH)

    def test_on_adds_second_pass_sharing_sampler_settings(self) -> None:
        values = {
            **BASE_VALUES,
            **HIRES_VALUES,
            "cfg": 5.5,
            "sampler_name": "dpmpp_2m",
            "scheduler": "karras",
        }
        workflow = workflow_module.build_workflow(TEMPLATE, values).workflow
        self.assertEqual(workflow["8"]["inputs"]["samples"], ["21", 0])
        self.assertEqual(workflow["20"]["inputs"]["samples"], ["3", 0])
        self.assertEqual(workflow["20"]["inputs"]["scale_by"], 2.0)
        self.assertEqual(workflow["20"]["inputs"]["upscale_method"], "bislerp")
        second = workflow["21"]["inputs"]
        self.assertEqual(second["latent_image"], ["20", 0])
        self.assertEqual(second["steps"], 12)
        self.assertEqual(second["denoise"], 0.4)
        for key in ("seed", "cfg", "sampler_name", "scheduler"):
            self.assertEqual(second[key], workflow["3"]["inputs"][key], key)
        self.assertEqual(workflow["3"]["inputs"]["denoise"], 1)

    def test_rejects_out_of_range_values(self) -> None:
        cases = {
            "hires_scale": [0.99, 4.01, True, "2"],
            "hires_upscale_method": ["lanczos", ""],
            "hires_steps": [1001, -1],
            "hires_denoise": [-0.1, 1.1],
        }
        for name, bad_values in cases.items():
            for bad in bad_values:
                with self.subTest(name=name, value=bad):
                    values = {**BASE_VALUES, **HIRES_VALUES, name: bad}
                    with self.assertRaises(workflow_module.WorkflowError):
                        workflow_module.build_workflow(TEMPLATE, values)

    def test_output_size_follows_latent_rounding(self) -> None:
        self.assertEqual(
            workflow_module.hires_output_size(832, 1216, 2.0), (1664, 2432)
        )
        self.assertEqual(
            workflow_module.hires_output_size(832, 1216, 1.5), (1248, 1824)
        )
        # latent 104 x 1.05 = 109.2 -> 109、152 x 1.05 = 159.6 -> 160
        self.assertEqual(
            workflow_module.hires_output_size(832, 1216, 1.05), (872, 1280)
        )


class PrepareHiresTest(unittest.TestCase):
    def test_off_by_default_matches_legacy_graph(self) -> None:
        prepared = _prepare({"positive_prompt": "1girl"})
        self.assertEqual(_links(prepared.snapshot), LEGACY_GRAPH)
        self.assertIs(prepared.parameters["hires_enabled"], False)
        self.assertNotIn("hires_scale", prepared.parameters)

    def test_on_records_values_and_resolves_zero_steps(self) -> None:
        prepared = _prepare(
            {"positive_prompt": "1girl", "hires_enabled": True, "steps": 24}
        )
        second = prepared.snapshot["21"]["inputs"]
        self.assertEqual(second["steps"], 24)
        self.assertEqual(prepared.snapshot["20"]["inputs"]["scale_by"], 2.0)
        parameters = prepared.parameters
        self.assertIs(parameters["hires_enabled"], True)
        self.assertEqual(parameters["hires_scale"], 2.0)
        self.assertEqual(parameters["hires_upscale_method"], "nearest-exact")
        self.assertEqual(parameters["hires_steps"], 24)
        self.assertEqual(parameters["hires_denoise"], 0.5)

    def test_rejects_output_larger_than_limit(self) -> None:
        with self.assertRaises(PreparationError):
            _prepare(
                {
                    "positive_prompt": "1girl",
                    "hires_enabled": True,
                    "hires_scale": 4.0,
                    "width": 2056,
                }
            )
        # 8192ちょうどは通す。
        _prepare(
            {
                "positive_prompt": "1girl",
                "hires_enabled": True,
                "hires_scale": 4.0,
                "width": 2048,
                "height": 1024,
            }
        )

    def test_rejects_non_bool_enabled(self) -> None:
        with self.assertRaises(PreparationError):
            _prepare({"positive_prompt": "1girl", "hires_enabled": "true"})


if __name__ == "__main__":
    unittest.main()
