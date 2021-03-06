import { Puzzle, PuzzleCompleteData } from "@prisma/client";
import { Request, Response } from "express";
import { client } from "../prisma/client";
import { AppError } from "../Errors/AppError";
import difficultyRanges from "../utils/difficultyRanges";
import difficultyLabels from "../utils/difficultyLabels";

type category =
  | "official"
  | "top-rated"
  | "new"
  | "easy"
  | "medium"
  | "hard"
  | "mine"
  | "completed";

type PuzzleMetadata = Omit<Puzzle, "data"> & {
  completed: boolean;
  liked: boolean;
};

type PuzzleSubmit = Pick<
  Puzzle,
  "shortKey" | "title" | "data" | "description" | "minimumComponents"
>;

type PuzzleSearch = {
  searchTerm: string;
  duration: "short" | "medium" | "long" | "any";
  includeCompleted: boolean;
  difficulty: "easy" | "medium" | "hard" | "any";
};

type Difficulty = 1 | 2 | 3;

class PuzzlesController {
  async list(request: Request, response: Response) {
    const category = request.params.category as category;

    switch (category) {
      case "official":
        const officialPuzzles = await client.puzzle.findMany({
          where: {
            user: null,
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(officialPuzzles, response.locals.userId));

      case "completed":
        const completedPuzzles = await client.puzzle.findMany({
          where: {
            completionsData: {
              some: {
                userId: response.locals.userId,
                completed: true,
              },
            },
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(completedPuzzles, response.locals.userId));

      case "mine":
        const myPuzzles = await client.puzzle.findMany({
          where: {
            author: response.locals.userId,
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(myPuzzles, response.locals.userId));

      case "new":
        const newPuzzles = await client.puzzle.findMany({
          orderBy: {
            createdAt: "desc",
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(newPuzzles, response.locals.userId));

      case "top-rated":
        const topRatedPuzzles = await client.puzzle.findMany({
          orderBy: {
            likes: "desc",
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(topRatedPuzzles, response.locals.userId));

      case "easy":
      case "medium":
      case "hard":
        const range = difficultyRanges[category];
        const puzzlesByDificulty = await client.puzzle.findMany({
          where: {
            difficulty: {
              gte: range["min"],
              lt: range["max"],
            },
          },
        });
        return response
          .status(200)
          .json(await onlyMetadata(puzzlesByDificulty, response.locals.userId));

      default:
        throw new Error("Invalid category!");
    }
  }

  async search(request: Request, response: Response) {
    const { searchTerm, duration, difficulty, includeCompleted } =
      request.body as PuzzleSearch;

    const puzzles = await client.puzzle.findMany({
      where: {
        OR: [
          {
            title: {
              contains: searchTerm as string,
            },
          },
          {
            description: {
              contains: searchTerm as string,
            },
          },
        ],
        // TODO implement difficulty search
        // difficulty: difficulty as string,
      },
    });

    if (!puzzles) {
      return response.status(404).send();
    }

    let metadata = await onlyMetadata(puzzles, response.locals.userId);
    if (!includeCompleted) {
      metadata = metadata.filter((puzzle) => puzzle.completed === false);
    }

    if (difficulty && difficulty !== "any") {
      const range = difficultyRanges[difficulty];
      metadata = metadata.filter(
        (puzzle) =>
          puzzle.difficulty &&
          puzzle.difficulty >= range["min"] &&
          puzzle.difficulty < range["max"]
      );
    }

    if (duration && duration !== "any") {
      metadata = metadata.filter((puzzle) => {
        if (puzzle.averageTime) {
          switch (duration) {
            case "short":
              return puzzle.averageTime < 120;
            case "long":
              return puzzle.averageTime > 600;
            default:
              return puzzle.averageTime >= 120 && puzzle.averageTime <= 600;
          }
        }
      });
    }

    return response.status(200).json(metadata);
  }

  async report(request: Request, response: Response) {
    const puzzleId = request.params.puzzleId;

    // verify if request.body has reason
    const reason = request.body.reason;

    if (!reason) {
      return response.status(400).send("Missing reason");
    }

    const report = await client.puzzleReport.create({
      data: {
        puzzleId: +puzzleId,
        userId: response.locals.userId,
        reason: request.body.reason,
      },
    });

    if (!report) {
      return response.status(500).send("Failed to report puzzle");
    }

    return response.status(201).json(report);
  }

  async submit(request: Request, response: Response) {
    const { shortKey, title, data, description, minimumComponents } =
      request.body as PuzzleSubmit;

    const user = await client.user.findUnique({
      where: {
        id: response.locals.userId,
      },
    });

    // Never should happen
    if (user == null) {
      throw new AppError("Authentication inconsistency!", 401);
    }

    const puzzle = await client.puzzle.create({
      data: {
        shortKey,
        title,
        data,
        author: user.id,
        authorName: user.name,
        description: "placeholder",
        minimumComponents: 1,
        minimumNands: 1,
      },
    });

    return response.status(201).json(puzzle);
  }

  async complete(request: Request, response: Response) {
    const puzzleId: number = +request.params.puzzleId;

    const puzzle = await findPuzzleById(puzzleId);

    if (!puzzle) {
      return response.status(404).send();
    }

    const {
      time,
      liked,
      componentsUsed = 0,
      nandsUsed = 0,
      difficultyRating,
    } = request.body;

    // In reality, we only have one
    const completeData = await client.puzzleCompleteData.updateMany({
      where: {
        puzzleId,
        userId: response.locals.userId,
      },
      data: {
        timeTaken: time,
        liked,
        componentsUsed,
        nandsUsed,
        difficultyRating,
        completed: true,
      },
    });

    const newAverage = calculateNewAverage(puzzle, time);

    await client.puzzle.update({
      where: {
        id: puzzleId,
      },
      data: {
        likes: puzzle.likes + liked ? 1 : 0,
        completions: puzzle.completions + 1,
        averageTime: newAverage,
        difficulty: calculateDifficulty(newAverage, difficultyRating),
      },
    });

    return response.status(200).json(completeData);
  }

  async download(request: Request, response: Response) {
    const puzzleId = +request.params.puzzleId;

    const puzzle = await findPuzzleById(puzzleId);

    if (!puzzle) {
      return response.status(404).send();
    }

    const userId = response.locals.userId;
    const completeData = await findPuzzleCompleteData(puzzleId, userId);

    if (!completeData) {
      await client.puzzleCompleteData.create({
        data: {
          userId,
          puzzleId,
        },
      });

      puzzle.downloads++;

      await client.puzzle.update({
        where: {
          id: puzzleId,
        },
        data: {
          downloads: puzzle.downloads,
        },
      });
    }

    const { data, ...metaData } = puzzle;

    let difficultyRating: string | undefined | null;

    if (!completeData || completeData.difficultyRating === null) {
      difficultyRating = undefined;
    } else if (completeData && completeData.difficultyRating >= 0) {
      difficultyRating = difficultyLabels[completeData?.difficultyRating];
    }

    return response.status(200).json({
      game: data,
      meta: {
        ...metaData,
        liked: completeData?.liked,
        difficultyRating,
      },
    });
  }

  async delete(request: Request, response: Response) {
    const puzzleId = +request.params.puzzleId;
    const user = response.locals.userId;

    const puzzle = await client.puzzle.findFirst({
      where: {
        id: puzzleId,
        author: user,
      },
    });

    if (!puzzle) {
      return response.status(200).json({ success: false });
    }

    await client.puzzle.delete({
      where: {
        id: puzzleId,
      },
    });

    return response.status(200).json({ success: true });
  }
}

function findPuzzleCompleteData(
  puzzleId: number,
  userId: string
): Promise<PuzzleCompleteData | null> {
  return client.puzzleCompleteData.findFirst({
    where: {
      puzzleId,
      userId,
    },
  });
}

// TODO maybe get metadata by joins, or at least fetch all puzzles at once
function onlyMetadata(
  puzzles: Puzzle[],
  userId: string
): Promise<PuzzleMetadata[]> {
  return Promise.all(
    puzzles.map(async (puzzle) => {
      const completeData = await findPuzzleCompleteData(puzzle.id, userId);

      const { data, ...incompleteData } = puzzle;
      const metaData = incompleteData as PuzzleMetadata;

      if (completeData) {
        metaData.completed = completeData.completed;
        metaData.liked = completeData.liked;
      } else {
        metaData.completed = false;
        metaData.liked = false;
      }

      return metaData;
    })
  );
}

function findPuzzleById(puzzleId: number): Promise<Puzzle | null> {
  return client.puzzle.findFirst({
    where: {
      id: puzzleId,
    },
  });
}

function calculateNewAverage(puzzle: Puzzle, time: number): number {
  return (
    ((puzzle.averageTime ? puzzle.averageTime : 0) * puzzle.completions +
      time) /
    (puzzle.completions + 1)
  );
}

// Needs to return a number between 0 and 1 no matter the inputs
function calculateDifficulty(
  averageTime: number,
  difficultyRating: Difficulty
): number {
  return (
    (1 / (1 + Math.pow(Math.E, -(averageTime * difficultyRating) / 300)) -
      0.5) *
    2
  );
}

export { PuzzlesController };
